import type { FastifyPluginAsync } from "fastify";
import multipart from "@fastify/multipart";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Deps } from "../app.ts";
import type { makeGuards } from "../http/context.ts";
import { withTenant } from "../db/client.ts";
import { customers, jobs, quotes } from "../db/schema.ts";
import { createManualJob, MAX_FILES, MAX_FILE_BYTES, type IncomingFile } from "../services/intake.ts";
import { insertQuote, view } from "../services/quotes.ts";
import { enqueue, Q } from "../queue.ts";
import { audit } from "../services/audit.ts";
import { AppError, notFound } from "../http/errors.ts";

type Guards = ReturnType<typeof makeGuards>;
const IdParam = z.object({ id: z.uuid() });
const FileParam = z.object({ id: z.uuid(), n: z.coerce.number().int().min(0).max(MAX_FILES - 1) });
const Source = z.enum(["paste", "upload", "share", "site_notes"]);

export const jobRoutes = ({ db, boss, store }: Deps, g: Guards): FastifyPluginAsync => async (app) => {
  await app.register(multipart, { limits: { files: MAX_FILES, fileSize: MAX_FILE_BYTES, fields: 10, fieldSize: 100_000 } });
  app.addHook("preHandler", g.requireTenant);

  // Paste / upload / share target / site notes — one job shape, one pipeline (§15).
  // Accepts multipart (text + photos) or JSON (text only).
  app.post("/jobs", async (req, reply) => {
    const fields: Record<string, string> = {};
    const files: IncomingFile[] = [];
    if (req.isMultipart()) {
      for await (const part of req.parts()) {
        if (part.type === "file") {
          const bytes = await part.toBuffer();
          if (part.file.truncated) throw new AppError(413, "FILE_TOO_LARGE", `${part.filename} is over 10 MB`);
          if (bytes.length) files.push({ filename: part.filename, contentType: part.mimetype, bytes });
        } else {
          fields[part.fieldname] = String(part.value);
        }
      }
    } else {
      Object.assign(fields, z.record(z.string(), z.string()).parse(req.body ?? {}));
    }
    const input = z.object({
      text: z.string().max(50_000).default(""),
      source: Source.default(files.length ? "upload" : "paste"),
      customerId: z.uuid().optional(),
    }).parse(fields);
    const job = await createManualJob(db, boss, store, req.tenant!, { ...input, files });
    return reply.code(201).send({ id: job.id, status: job.status, source: job.source });
  });

  app.get("/jobs", async (req) => {
    const t = req.tenant!;
    return withTenant(db, t.businessId, (tx) => tx.select({
      id: jobs.id, source: jobs.source, status: jobs.status, subject: jobs.subject, createdAt: jobs.createdAt,
      customerName: customers.name, quoteId: quotes.id,
    }).from(jobs)
      .leftJoin(customers, eq(customers.id, jobs.customerId))
      .leftJoin(quotes, eq(quotes.jobId, jobs.id))
      .where(eq(jobs.businessId, t.businessId))
      .orderBy(desc(jobs.createdAt)).limit(200));
  });

  // Job detail: the original beside the extraction — the audit view's source (§21).
  app.get("/jobs/:id", async (req) => {
    const { id } = IdParam.parse(req.params);
    const t = req.tenant!;
    return withTenant(db, t.businessId, async (tx) => {
      const [j] = await tx.select().from(jobs).where(and(eq(jobs.businessId, t.businessId), eq(jobs.id, id)));
      if (!j) throw notFound("job");
      const [q] = await tx.select({ id: quotes.id }).from(quotes).where(and(eq(quotes.businessId, t.businessId), eq(quotes.jobId, id)));
      const ex = j.extraction as { questions?: string[]; summary?: string; urgency?: string } | null;
      return {
        id: j.id, source: j.source, status: j.status, subject: j.subject, createdAt: j.createdAt,
        customerId: j.customerId, originalText: j.originalText, contactHint: j.contactHint,
        files: j.originalFiles.map((f, n) => ({ n, filename: f.filename, contentType: f.contentType, size: f.size, preview: !!f.modelKey })),
        summary: ex?.summary ?? null, urgency: ex?.urgency ?? null, questions: ex?.questions ?? [],
        lastError: j.lastError, quoteId: q?.id ?? null,
      };
    });
  });

  // Files are served through the API, never from the app origin directly: the
  // resized JPEG we generated is shown inline; originals always download (§9).
  app.get("/jobs/:id/files/:n", async (req, reply) => {
    const { id, n } = FileParam.parse(req.params);
    const { variant } = z.object({ variant: z.enum(["preview", "original"]).default("preview") }).parse(req.query);
    const t = req.tenant!;
    const [j] = await withTenant(db, t.businessId, (tx) =>
      tx.select({ files: jobs.originalFiles }).from(jobs).where(and(eq(jobs.businessId, t.businessId), eq(jobs.id, id))));
    const f = j?.files[n];
    if (!f) throw notFound("file");
    if (variant === "preview" && f.modelKey) {
      const o = await store.get(f.modelKey);
      return reply.type("image/jpeg").header("cache-control", "private, max-age=300").header("x-content-type-options", "nosniff").send(o.body);
    }
    const o = await store.get(f.key);
    return reply.type("application/octet-stream")
      .header("content-disposition", `attachment; filename="${f.filename.replace(/[^\w.-]/g, "_")}"`)
      .header("x-content-type-options", "nosniff").send(o.body);
  });

  // Re-run extraction after a failure.
  app.post("/jobs/:id/retry", async (req) => {
    const { id } = IdParam.parse(req.params);
    const t = req.tenant!;
    return withTenant(db, t.businessId, async (tx) => {
      const [j] = await tx.update(jobs).set({ status: "received", lastError: null, updatedAt: new Date() })
        .where(and(eq(jobs.businessId, t.businessId), eq(jobs.id, id), eq(jobs.status, "extraction_failed")))
        .returning({ id: jobs.id });
      if (!j) throw new AppError(409, "NOT_RETRYABLE", "only a failed extraction can be retried");
      await audit(tx, t.businessId, t.userId, "job", id, "job.retry");
      await enqueue(boss, tx, Q.extract, { businessId: t.businessId, jobId: id }, { singletonKey: `extract:${id}` });
      return { id, status: "received" };
    });
  });

  // Manual-entry fallback: a blank draft linked to the job (§16 — the job is
  // never lost because the model failed).
  app.post("/jobs/:id/quote", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const t = req.tenant!;
    const q = await withTenant(db, t.businessId, async (tx) => {
      const [j] = await tx.select().from(jobs).where(and(eq(jobs.businessId, t.businessId), eq(jobs.id, id))).for("update");
      if (!j) throw notFound("job");
      const [existing] = await tx.select({ id: quotes.id }).from(quotes).where(and(eq(quotes.businessId, t.businessId), eq(quotes.jobId, id)));
      if (existing) throw new AppError(409, "QUOTE_EXISTS", "this job already has a quote", { quoteId: existing.id });
      const row = await insertQuote(tx, t.businessId, t.userId, { customerId: j.customerId, jobId: id });
      await tx.update(jobs).set({ status: "in_review", updatedAt: new Date() }).where(eq(jobs.id, id));
      return row;
    });
    return reply.code(201).send(view(q, []));
  });
};
