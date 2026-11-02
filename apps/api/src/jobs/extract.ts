// extract (design §16): LLM → validate → retry once with the problems →
// match the price book → draft quote (or needs_info / not a job / failed).
// Idempotent: re-running for a job that already has a result is a no-op.
import { and, eq, sql } from "drizzle-orm";
import { ExtractionResult } from "@qa/shared";
import { type Tx, withTenant } from "../db/client.ts";
import { customers, jobs, quotes, usageCounters } from "../db/schema.ts";
import { callAndLog, type ModelImage } from "../llm/gateway.ts";
import { loadCatalogue, renderInstructions, renderInput, validateExtraction, PROMPT_VERSION } from "../services/extraction.ts";
import { parseForwarded } from "../services/forwarded.ts";
import { matchLines } from "../services/matcher.ts";
import { createDraftFromLines } from "../services/quotes.ts";
import { notifyOwners } from "../services/notify.ts";
import { audit } from "../services/audit.ts";
import type { WorkerDeps } from "./deps.ts";

const MAX_ATTEMPTS = 2;   // first try + one retry with the validation problems (§16)

type Outcome = "draft_ready" | "needs_info" | "not_a_job" | "extraction_failed" | "skipped" | "spend_cap";

export async function extract(d: WorkerDeps, data: { businessId: string; jobId: string }): Promise<{ outcome: Outcome; quoteId?: string }> {
  const { businessId, jobId } = data;

  // 1. Claim the job and gather inputs.
  const prep = await withTenant(d.db, businessId, async (tx) => {
    const [job] = await tx.select().from(jobs).where(and(eq(jobs.businessId, businessId), eq(jobs.id, jobId))).for("update");
    if (!job || !["received", "extracting"].includes(job.status)) return null;
    const [existing] = await tx.select({ id: quotes.id }).from(quotes).where(and(eq(quotes.businessId, businessId), eq(quotes.jobId, jobId)));
    if (existing) return null;
    if (job.source === "email_forward" && job.originalText === "" && job.originalFiles.length === 0) return null; // not fetched yet

    const [usage] = await tx.select({ cost: usageCounters.llmCostUsd }).from(usageCounters)
      .where(and(eq(usageCounters.businessId, businessId), eq(usageCounters.month, sql`date_trunc('month', current_date)::date`)));
    if (usage && Number(usage.cost) >= d.llmMonthlyCapUsd) {
      await tx.update(jobs).set({ lastError: "monthly AI spend cap reached", updatedAt: new Date() }).where(eq(jobs.id, jobId));
      await notifyOwners(d.boss, tx, businessId, "spend_cap", `cap:${new Date().toISOString().slice(0, 7)}`);
      return { capped: true as const };
    }

    await tx.update(jobs).set({ status: "extracting", updatedAt: new Date() }).where(eq(jobs.id, jobId));
    return { capped: false as const, job, catalogue: await loadCatalogue(tx, businessId) };
  });
  if (!prep) return { outcome: "skipped" };
  if (prep.capped) return { outcome: "spend_cap" };
  const { job, catalogue } = prep;

  // Forwarded blocks are parsed whichever door they came through (a pasted
  // forward is as common as a forwarded one); site notes are the owner's own words.
  const forwarded = job.source !== "site_notes" ? parseForwarded(job.originalText) : null;
  const cleanedText = forwarded ? forwarded.cleanedText : job.originalText;
  const contactHint = job.contactHint ?? forwarded?.contactHint ?? null;
  const images: ModelImage[] = [];
  for (const f of job.originalFiles) {
    if (f.modelKey) images.push({ mime: "image/jpeg", data: (await d.store.get(f.modelKey)).body });
  }
  const author = job.source === "site_notes" ? "tradesperson" : "customer";
  const catalogueIds = new Set(catalogue.map((c) => c.id));

  // 2. Model call, validated; one retry with the problems appended.
  let problems: string[] = [];
  let result: ExtractionResult | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await callAndLog(d.db, d.llm, d.pricing,
      { businessId, jobId, purpose: attempt === 1 ? "extract" : "extract_retry", promptVersion: PROMPT_VERSION },
      { instructions: renderInstructions(author, catalogue, problems), text: renderInput(cleanedText, contactHint, images.length), images },
      ExtractionResult, "extraction");
    const v = validateExtraction(ExtractionResult.parse(res.output), cleanedText, catalogueIds);
    result = v.result;
    problems = v.problems;
    if (!problems.length) break;
  }

  // 3. Store the outcome in one transaction.
  return withTenant(d.db, businessId, async (tx) => {
    const [cur] = await tx.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, jobId)).for("update");
    if (cur?.status !== "extracting") return { outcome: "skipped" as const };
    const base = { extraction: result, extractionAttempts: sql`${jobs.extractionAttempts} + 1`, updatedAt: new Date() };

    if (problems.length || !result) {
      await tx.update(jobs).set({ ...base, status: "extraction_failed", lastError: problems.join("; ").slice(0, 2000) }).where(eq(jobs.id, jobId));
      await audit(tx, businessId, "system", "job", jobId, "job.extraction_failed", { problems });
      await notifyOwners(d.boss, tx, businessId, "extraction_failed", jobId);
      return { outcome: "extraction_failed" as const };
    }
    if (!result.isEnquiry) {
      await tx.update(jobs).set({ ...base, status: "closed", lastError: "not a customer enquiry" }).where(eq(jobs.id, jobId));
      await audit(tx, businessId, "system", "job", jobId, "job.not_a_job");
      return { outcome: "not_a_job" as const };
    }

    const customerId = job.customerId ?? (await resolveCustomer(tx, businessId, result, contactHint));
    if (customerId && !job.customerId) await tx.update(jobs).set({ customerId }).where(eq(jobs.id, jobId));

    if (result.lines.length === 0) {
      await tx.update(jobs).set({ ...base, status: "needs_info", lastError: null }).where(eq(jobs.id, jobId));
      await audit(tx, businessId, "system", "job", jobId, "job.needs_info", { questions: result.questions });
      await notifyOwners(d.boss, tx, businessId, "needs_info", jobId);
      return { outcome: "needs_info" as const };
    }

    const { lines, stages } = await matchLines(tx, businessId, result.lines);
    const q = await createDraftFromLines(tx, businessId, { customerId, jobId }, lines);
    await tx.update(jobs).set({ ...base, status: "draft_ready", lastError: null }).where(eq(jobs.id, jobId));
    await audit(tx, businessId, "system", "job", jobId, "job.draft_ready", { quoteId: q.id, stages });
    await notifyOwners(d.boss, tx, businessId, "draft_ready", jobId);
    return { outcome: "draft_ready" as const, quoteId: q.id };
  });
}

// Existing customer by email or phone; otherwise create one when there is a
// way to contact them. With no contact at all the draft has no customer yet,
// and approval will ask for one.
async function resolveCustomer(tx: Tx, businessId: string, r: ExtractionResult, hint: { name: string | null; email: string | null } | null) {
  const email = (hint?.email ?? r.customer.email)?.toLowerCase() ?? null;
  const phone = r.customer.phone?.trim() || null;
  const digits = phone?.replace(/\D/g, "") ?? "";
  if (email) {
    const [c] = await tx.select({ id: customers.id }).from(customers)
      .where(and(eq(customers.businessId, businessId), sql`lower(${customers.email}) = ${email}`));
    if (c) return c.id;
  }
  if (digits.length >= 7) {
    const [c] = await tx.select({ id: customers.id }).from(customers)
      .where(and(eq(customers.businessId, businessId), sql`regexp_replace(coalesce(${customers.phone}, ''), '\\D', '', 'g') = ${digits}`));
    if (c) return c.id;
  }
  if (!email && !phone) return null;
  const [c] = await tx.insert(customers).values({
    businessId, name: r.customer.name ?? hint?.name ?? email ?? phone ?? "Customer",
    email, phone, siteAddress: r.customer.siteAddress,
  }).returning({ id: customers.id });
  await audit(tx, businessId, "system", "customer", c!.id, "customer.created_from_extraction");
  return c!.id;
}
