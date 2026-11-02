// LLM gateway (design §5): the single choke point for model calls — provider
// interface, transient-error retries, and token/cost logging per call.
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { sql } from "drizzle-orm";
import type { ZodType } from "zod";
import { type Db, withTenant } from "../db/client.ts";
import { llmCalls, usageCounters } from "../db/schema.ts";

export interface ModelImage { mime: "image/jpeg"; data: Buffer }
export interface ModelRequest { instructions: string; text: string; images: ModelImage[] }
export interface ModelResponse { output: unknown; model: string; inputTokens: number; outputTokens: number }

export interface LlmProvider {
  readonly model: string;
  structured(req: ModelRequest, schema: ZodType, name: string): Promise<ModelResponse>;
}

export function openAiProvider(opts: { apiKey: string; model: string; temperature?: number | undefined }): LlmProvider {
  const client = new OpenAI({ apiKey: opts.apiKey, maxRetries: 2, timeout: 90_000 });
  return {
    model: opts.model,
    async structured(req, schema, name) {
      const res = await client.responses.parse({
        model: opts.model,
        instructions: req.instructions,
        input: [{
          role: "user",
          content: [
            { type: "input_text", text: req.text },
            ...req.images.map((i) => ({
              type: "input_image" as const, detail: "auto" as const,
              image_url: `data:${i.mime};base64,${i.data.toString("base64")}`,
            })),
          ],
        }],
        text: { format: zodTextFormat(schema, name) },
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      });
      if (!res.output_parsed) throw new Error("model returned no parsed output (refusal or empty)");
      return { output: res.output_parsed, model: res.model, inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 };
    },
  };
}

// Tests and local development without a key: answers from a script.
export function scriptedProvider(script: (req: ModelRequest, call: number) => unknown, model = "scripted-v1"): LlmProvider & { calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  return {
    model, calls,
    async structured(req, schema) {
      calls.push(req);
      const out = await script(req, calls.length);
      return { output: schema.parse(out), model, inputTokens: Math.ceil(req.instructions.length / 4) + Math.ceil(req.text.length / 4), outputTokens: 200 };
    },
  };
}

export interface Pricing { inputUsdPerMTok: number; outputUsdPerMTok: number }

export async function callAndLog(
  db: Db, provider: LlmProvider, pricing: Pricing,
  ctx: { businessId: string; jobId: string; purpose: string; promptVersion: string },
  req: ModelRequest, schema: ZodType, name: string,
): Promise<ModelResponse> {
  const started = performance.now();
  const res = await provider.structured(req, schema, name);
  const latencyMs = Math.round(performance.now() - started);
  const cost = (res.inputTokens * pricing.inputUsdPerMTok + res.outputTokens * pricing.outputUsdPerMTok) / 1_000_000;
  await withTenant(db, ctx.businessId, async (tx) => {
    await tx.insert(llmCalls).values({
      businessId: ctx.businessId, jobId: ctx.jobId, purpose: ctx.purpose, model: res.model, promptVersion: ctx.promptVersion,
      inputTokens: res.inputTokens, outputTokens: res.outputTokens, imageCount: req.images.length,
      costUsd: cost.toFixed(6), latencyMs,
    });
    await tx.insert(usageCounters)
      .values({ businessId: ctx.businessId, month: sql`date_trunc('month', current_date)::date`, llmCostUsd: cost.toFixed(6) })
      .onConflictDoUpdate({
        target: [usageCounters.businessId, usageCounters.month],
        set: { llmCostUsd: sql`${usageCounters.llmCostUsd} + ${cost.toFixed(6)}::numeric` },
      });
  });
  return res;
}
