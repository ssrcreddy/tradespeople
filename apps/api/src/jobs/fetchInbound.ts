// fetch-inbound (design §15): the webhook carried metadata only; fetch body and
// attachments now, store them, fill the job once, then enqueue extraction.
import { and, eq } from "drizzle-orm";
import { withTenant } from "../db/client.ts";
import { jobs } from "../db/schema.ts";
import { enqueue, Q } from "../queue.ts";
import { storeFiles, MAX_FILES } from "../services/intake.ts";
import { parseForwarded, htmlToText } from "../services/forwarded.ts";
import type { WorkerDeps } from "./deps.ts";

export async function fetchInbound(d: WorkerDeps, data: { businessId: string; jobId: string }) {
  const job = await withTenant(d.db, data.businessId, async (tx) =>
    (await tx.select().from(jobs).where(and(eq(jobs.businessId, data.businessId), eq(jobs.id, data.jobId))))[0]);
  if (!job || !job.providerMessageId) return { skipped: "no such email job" };

  const alreadyFetched = job.originalText !== "" || job.originalFiles.length > 0;
  if (!alreadyFetched) {
    const email = await d.inbound.fetch(job.providerMessageId);   // throws → pg-boss retries with backoff
    await d.store.put(`${data.businessId}/inbound/${job.providerMessageId}/email.json`, Buffer.from(JSON.stringify(email.raw)), "application/json");
    const text = email.text.trim() ? email.text : htmlToText(email.html);
    const files = await storeFiles(d.store, data.businessId, job.id, email.attachments.slice(0, MAX_FILES));
    const { contactHint } = parseForwarded(text);

    await withTenant(d.db, data.businessId, async (tx) => {
      // Fill once: the original is the audit anchor and never changes after this.
      await tx.update(jobs).set({
        originalText: text, originalFiles: files, subject: email.subject || job.subject,
        contactHint, updatedAt: new Date(),
      }).where(and(eq(jobs.businessId, data.businessId), eq(jobs.id, job.id), eq(jobs.originalText, "")));
      await enqueue(d.boss, tx, Q.extract, data, { singletonKey: `extract:${job.id}` });
    });
    return { fetched: true, attachments: files.length };
  }

  await withTenant(d.db, data.businessId, (tx) => enqueue(d.boss, tx, Q.extract, data, { singletonKey: `extract:${job.id}` }));
  return { fetched: false };
}
