// Builds the shared dependencies for both modes (HTTP and worker) from config.
// Without provider keys the app still runs locally: inbound email is disabled,
// mail is logged, and extraction refuses to run (jobs wait in the queue).
import { createDb } from "./db/client.ts";
import { createAuth } from "./auth.ts";
import { createBoss } from "./queue.ts";
import { s3Store } from "./storage.ts";
import { resendInbound, type InboundProvider } from "./inbound.ts";
import { resendMailer, memoryMailer } from "./mail.ts";
import { readFileSync } from "node:fs";
import { openAiProvider, scriptedProvider, type LlmProvider } from "./llm/gateway.ts";
import type { Config } from "./config.ts";

const unavailableInbound: InboundProvider = {
  verify() { throw new Error("inbound email is not configured (RESEND_API_KEY / RESEND_INBOUND_SECRET)"); },
  verifyDelivery() { throw new Error("email events are not configured"); },
  async fetch() { throw new Error("inbound email is not configured"); },
};

const unavailableLlm: LlmProvider = {
  model: "none",
  async structured() { throw new Error("LLM is not configured (OPENAI_API_KEY / STRONG_MODEL)"); },
};

export function buildRuntime(cfg: Config, mode: "http" | "worker") {
  const { db, pool } = createDb(cfg.databaseUrl);
  const boss = createBoss(cfg.databaseUrl, { worker: mode === "worker" });
  return {
    cfg, db, pool, boss,
    auth: createAuth(db, cfg),
    store: s3Store(cfg.s3),
    inbound: cfg.resend?.inboundSecret ? resendInbound(cfg.resend.apiKey, cfg.resend.inboundSecret, cfg.resend.eventsSecret) : unavailableInbound,
    mailer: cfg.resend ? resendMailer(cfg.resend.apiKey, cfg.resend.sender) : memoryMailer(true),
    llm: cfg.openai
      ? openAiProvider(cfg.openai)
      // Development only: answer every extraction with a fixed fixture, so the
      // pipeline and review screen can be exercised without a model key.
      : cfg.fakeLlmFile && !cfg.production
        ? scriptedProvider(() => JSON.parse(readFileSync(cfg.fakeLlmFile!, "utf8")), "fake-fixture")
        : unavailableLlm,
  };
}
