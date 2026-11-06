// Intake (design §15): one pipeline, several doors — forwarded email, paste,
// upload, share, site notes. Each creates the same job shape and enqueues its
// next step in the same transaction.
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { type Db, type Tx, withTenant } from "../db/client.ts";
import { businesses, customers, emailEvents, emailSuppressions, inboundMessages, jobs, type JobFile } from "../db/schema.ts";
import { enqueue, Q, type Boss } from "../queue.ts";
import type { ObjectStore } from "../storage.ts";
import { type InboundProvider, intakeTokenOf, bareAddress } from "../inbound.ts";
import { processImage, sniffImage } from "./images.ts";
import { notifyOwners } from "./notify.ts";
import { audit } from "./audit.ts";
import { AppError, notFound } from "../http/errors.ts";
import type { TenantCtx } from "../http/context.ts";

export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export interface IncomingFile { filename: string; contentType: string; bytes: Buffer }

const safeName = (n: string) => n.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80) || "file";

// Stores originals and, for images, the resized metadata-free model copy.
// Object storage is not transactional: a crash after this leaves orphan
// objects, never a job pointing at missing files.
export async function storeFiles(store: ObjectStore, businessId: string, jobId: string, files: IncomingFile[]): Promise<JobFile[]> {
  if (files.length > MAX_FILES) throw new AppError(413, "TOO_MANY_FILES", `at most ${MAX_FILES} files per message`);
  const out: JobFile[] = [];
  for (const [n, f] of files.entries()) {
    if (f.bytes.length > MAX_FILE_BYTES) throw new AppError(413, "FILE_TOO_LARGE", `${f.filename} is over 10 MB`);
    const base = `${businessId}/jobs/${jobId}/${n}`;
    const kind = sniffImage(f.bytes);      // trust bytes, not the declared type
    const key = `${base}-orig-${safeName(f.filename)}`;
    await store.put(key, f.bytes, kind ? f.contentType || "application/octet-stream" : "application/octet-stream");
    let modelKey: string | null = null;
    let sha256: string;
    if (kind) {
      const img = await processImage(f.bytes);
      modelKey = `${base}-model.jpg`;
      await store.put(modelKey, img.model, "image/jpeg");
      sha256 = img.sha256;
    } else {
      sha256 = createHash("sha256").update(f.bytes).digest("hex");
    }
    out.push({ key, filename: f.filename, contentType: f.contentType, sha256, size: f.bytes.length, modelKey });
  }
  return out;
}

export interface ManualJobInput {
  text: string;
  source: "paste" | "upload" | "share" | "site_notes";
  customerId?: string | undefined;
  files: IncomingFile[];
}

export async function createManualJob(db: Db, boss: Boss, store: ObjectStore, t: TenantCtx, input: ManualJobInput) {
  if (!input.text.trim() && input.files.length === 0) throw new AppError(422, "EMPTY_JOB", "add some text or a photo");
  const jobId = randomUUID();
  const files = await storeFiles(store, t.businessId, jobId, input.files);
  return withTenant(db, t.businessId, async (tx) => {
    if (input.customerId) {
      const [c] = await tx.select({ id: customers.id }).from(customers)
        .where(and(eq(customers.businessId, t.businessId), eq(customers.id, input.customerId)));
      if (!c) throw notFound("customer");
    }
    const [job] = await tx.insert(jobs).values({
      id: jobId, businessId: t.businessId, customerId: input.customerId ?? null,
      source: input.source, originalText: input.text, originalFiles: files, status: "received",
    }).returning();
    await audit(tx, t.businessId, t.userId, "job", jobId, "job.created", { source: input.source, files: files.length });
    await enqueue(boss, tx, Q.extract, { businessId: t.businessId, jobId }, { singletonKey: `extract:${jobId}` });
    return job!;
  });
}

// ---------- forwarded email ----------

export interface WebhookDeps { db: Db; pool: import("pg").Pool; boss: Boss; store: ObjectStore; inbound: InboundProvider; rateLimitPerHour: number }

export type WebhookOutcome = "ignored" | "duplicate" | "dropped" | "job" | "quarantined" | "rate_limited";

export async function handleInboundWebhook(d: WebhookDeps, rawBody: string, headers: Record<string, string | string[] | undefined>): Promise<WebhookOutcome> {
  let event;
  try {
    event = d.inbound.verify(rawBody, headers);
  } catch {
    throw new AppError(401, "BAD_SIGNATURE", "invalid webhook signature");
  }
  if (!event) return "ignored";

  const token = intakeTokenOf(event.to);
  const businessId = token
    ? (await d.pool.query<{ id: string | null }>("select app_business_by_intake_token($1) as id", [token])).rows[0]?.id ?? null
    : null;

  // Raw payload is stored before any decision is acted on (§15).
  const rawKey = `${businessId ?? "_unrouted"}/inbound/${safeName(event.providerMessageId)}/webhook.json`;
  await d.store.put(rawKey, Buffer.from(rawBody), "application/json");

  if (!businessId) {
    await d.pool.query("select app_record_unrouted_inbound($1, $2, $3)", [event.providerMessageId, rawKey, event.from]);
    return "dropped";                      // never create an untenanted job
  }

  return withTenant(d.db, businessId, async (tx) => {
    const [dupe] = await tx.select({ id: inboundMessages.id }).from(inboundMessages)
      .where(and(eq(inboundMessages.businessId, businessId), eq(inboundMessages.providerMessageId, event.providerMessageId)));
    if (dupe) return "duplicate";

    const disposition = await decideDisposition(tx, businessId, bareAddress(event.from), d.rateLimitPerHour);
    const [msg] = await tx.insert(inboundMessages).values({
      businessId, providerMessageId: event.providerMessageId, rawObjectKey: rawKey, fromAddr: event.from, disposition,
    }).onConflictDoNothing().returning();
    if (!msg) return "duplicate";

    if (disposition === "job") {
      await createEmailJob(d.boss, tx, businessId, msg.id, event.providerMessageId, event.subject, "system");
    } else if (disposition === "quarantined") {
      await notifyOwners(d.boss, tx, businessId, "quarantined", msg.id);
    } else {
      await notifyOwners(d.boss, tx, businessId, "rate_limited", `rate:${new Date().toISOString().slice(0, 13)}`);
    }
    return disposition;
  });
}

async function decideDisposition(tx: Tx, businessId: string, from: string, limit: number) {
  const [{ n }] = (await tx.select({ n: sql<number>`count(*)::int` }).from(inboundMessages)
    .where(and(eq(inboundMessages.businessId, businessId), gt(inboundMessages.receivedAt, sql`now() - interval '1 hour'`)))) as [{ n: number }];
  if (n >= limit) return "rate_limited" as const;

  // The token selects the tenant; it does not authorise (§9, §15).
  const [b] = await tx.select({ allow: businesses.senderAllowlist }).from(businesses).where(eq(businesses.id, businessId));
  if (b!.allow.some((a) => a.toLowerCase() === from)) return "job" as const;
  const [known] = await tx.select({ id: customers.id }).from(customers)
    .where(and(eq(customers.businessId, businessId), sql`lower(${customers.email}) = ${from}`));
  return known ? ("job" as const) : ("quarantined" as const);
}

async function createEmailJob(boss: Boss, tx: Tx, businessId: string, inboundId: string, providerMessageId: string, subject: string, actor: string) {
  const [job] = await tx.insert(jobs).values({
    businessId, source: "email_forward", inboundMessageId: inboundId, providerMessageId, subject, status: "received",
  }).onConflictDoNothing().returning({ id: jobs.id });
  if (!job) return null;
  await audit(tx, businessId, actor, "job", job.id, "job.created", { source: "email_forward" });
  await enqueue(boss, tx, Q.fetchInbound, { businessId, jobId: job.id }, { singletonKey: `fetch:${job.id}` });
  return job.id;
}

export async function listQuarantine(db: Db, t: TenantCtx) {
  return withTenant(db, t.businessId, (tx) => tx.select({
    id: inboundMessages.id, from: inboundMessages.fromAddr, receivedAt: inboundMessages.receivedAt, disposition: inboundMessages.disposition,
  }).from(inboundMessages)
    .where(and(eq(inboundMessages.businessId, t.businessId), sql`${inboundMessages.disposition} in ('quarantined', 'rate_limited')`))
    .orderBy(desc(inboundMessages.receivedAt)));
}

export async function releaseQuarantined(db: Db, boss: Boss, t: TenantCtx, inboundId: string, allowSender: boolean) {
  return withTenant(db, t.businessId, async (tx) => {
    const [m] = await tx.select().from(inboundMessages)
      .where(and(eq(inboundMessages.businessId, t.businessId), eq(inboundMessages.id, inboundId))).for("update");
    if (!m || (m.disposition !== "quarantined" && m.disposition !== "rate_limited")) throw notFound("held message");
    await tx.update(inboundMessages).set({ disposition: "job" }).where(eq(inboundMessages.id, m.id));
    if (allowSender) {
      await tx.update(businesses)
        .set({ senderAllowlist: sql`array_append(${businesses.senderAllowlist}, ${bareAddress(m.fromAddr)})` })
        .where(and(eq(businesses.id, t.businessId), sql`not (${bareAddress(m.fromAddr)} = any(${businesses.senderAllowlist}))`));
    }
    const jobId = await createEmailJob(boss, tx, t.businessId, m.id, m.providerMessageId, "", t.userId);
    await audit(tx, t.businessId, t.userId, "inbound_message", m.id, "inbound.released", { allowSender });
    return { jobId };
  });
}

// ---------- delivery events for outbound email ----------

export async function handleDeliveryEvent(
  d: Pick<WebhookDeps, "db" | "pool" | "boss" | "inbound">, rawBody: string, headers: Record<string, string | string[] | undefined>,
): Promise<string> {
  let e;
  try {
    e = d.inbound.verifyDelivery(rawBody, headers);
  } catch {
    throw new AppError(401, "BAD_SIGNATURE", "invalid webhook signature");
  }
  if (!e) return "ignored";
  const { rows } = await d.pool.query<{ business_id: string; kind: string; document_id: string }>(
    "select * from app_document_by_provider_email($1)", [e.providerEmailId]);
  const doc = rows[0];
  if (!doc) return "unknown";       // e.g. a reminder or owner notification: not tracked on a document

  const { type, recipient, providerEmailId } = e;
  await withTenant(d.db, doc.business_id, async (tx) => {
    await tx.insert(emailEvents).values({ businessId: doc.business_id, documentId: doc.document_id, providerId: providerEmailId, type });
    if ((type === "bounced" || type === "complained") && recipient) {
      await tx.insert(emailSuppressions)
        .values({ businessId: doc.business_id, email: bareAddress(recipient), reason: type === "bounced" ? "bounce" : "complaint" })
        .onConflictDoNothing();
    }
    if (type === "bounced") await notifyOwners(d.boss, tx, doc.business_id, "bounced", `${doc.kind}:${doc.document_id}`);
    await audit(tx, doc.business_id, "system", doc.kind, doc.document_id, `email.${type}`);
  });
  return type;
}
