// Leaving the product (design §9, §12, §21): an export bundle first, then a
// deletion that really removes rows and files. Deletion is the one operation
// that uses the privileged role, because audit_events is append-only for the app.
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import pg from "pg";
import { z } from "zod";
import { type Db, withTenant } from "../db/client.ts";
import { businesses, customers, invoices, jobs, payments, priceBookItems, quotes } from "../db/schema.ts";
import { enqueue, Q, type Boss } from "../queue.ts";
import type { ObjectStore } from "../storage.ts";
import { audit } from "./audit.ts";
import { AppError } from "../http/errors.ts";
import type { TenantCtx } from "../http/context.ts";

export const DeleteInput = z.object({
  confirmName: z.string(),
  exportWaived: z.boolean().default(false),
});

const EXPORT_FRESH_DAYS = 7;

function csv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]!);
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
    // Leading =+-@ would run as a formula when the file is opened in a spreadsheet.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
}

export async function requestExport(db: Db, boss: Boss, t: TenantCtx) {
  if (t.role !== "owner") throw new AppError(403, "OWNER_ONLY", "only the owner can export the business");
  return withTenant(db, t.businessId, async (tx) => {
    await audit(tx, t.businessId, t.userId, "business", t.businessId, "export.requested");
    await enqueue(boss, tx, Q.exportBusiness, { businessId: t.businessId }, { singletonKey: `export:${t.businessId}` });
    return { queued: true };
  });
}

// export-business job: CSVs plus every stored PDF, in one zip.
export async function buildExport(db: Db, store: ObjectStore, businessId: string) {
  const data = await withTenant(db, businessId, async (tx) => ({
    customers: await tx.select().from(customers).where(eq(customers.businessId, businessId)).orderBy(asc(customers.createdAt)),
    priceBook: await tx.select().from(priceBookItems).where(eq(priceBookItems.businessId, businessId)),
    quotes: await tx.select({
      id: quotes.id, number: quotes.number, version: quotes.version, status: quotes.status, customerId: quotes.customerId,
      subtotalCents: quotes.subtotalCents, discountCents: quotes.discountCents, taxCents: quotes.taxCents, totalCents: quotes.totalCents,
      sentAt: quotes.sentAt, sentVia: quotes.sentVia, pdfSha256: quotes.pdfSha256, createdAt: quotes.createdAt,
    }).from(quotes).where(eq(quotes.businessId, businessId)).orderBy(asc(quotes.number), asc(quotes.version)),
    invoices: await tx.select({
      id: invoices.id, number: invoices.number, kind: invoices.kind, quoteId: invoices.quoteId, status: invoices.status,
      dueDate: invoices.dueDate, amountCents: invoices.amountCents, taxCents: invoices.taxCents, paidCents: invoices.paidCents,
      sentAt: invoices.sentAt, pdfSha256: invoices.pdfSha256, createdAt: invoices.createdAt,
    }).from(invoices).where(eq(invoices.businessId, businessId)).orderBy(asc(invoices.number)),
    payments: await tx.select().from(payments).where(eq(payments.businessId, businessId)).orderBy(asc(payments.createdAt)),
    jobs: await tx.select({
      id: jobs.id, source: jobs.source, status: jobs.status, subject: jobs.subject, originalText: jobs.originalText, createdAt: jobs.createdAt,
    }).from(jobs).where(eq(jobs.businessId, businessId)).orderBy(asc(jobs.createdAt)),
    pdfs: [
      ...await tx.select({ key: quotes.pdfObjectKey }).from(quotes).where(and(eq(quotes.businessId, businessId), isNotNull(quotes.pdfObjectKey))),
      ...await tx.select({ key: invoices.pdfObjectKey }).from(invoices).where(and(eq(invoices.businessId, businessId), isNotNull(invoices.pdfObjectKey))),
    ],
  }));

  const files: Record<string, Uint8Array> = {};
  for (const [name, rows] of Object.entries({
    customers: data.customers, price_book: data.priceBook, quotes: data.quotes,
    invoices: data.invoices, payments: data.payments, jobs: data.jobs,
  })) files[`${name}.csv`] = strToU8(csv(rows as Record<string, unknown>[]));
  for (const { key } of data.pdfs) {
    files[`documents/${key!.split("/").pop()}`] = new Uint8Array((await store.get(key!)).body);
  }

  const key = `${businessId}/exports/export-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
  await store.put(key, Buffer.from(zipSync(files)), "application/zip");
  await withTenant(db, businessId, async (tx) => {
    await tx.update(businesses).set({ lastExportKey: key, lastExportAt: new Date() }).where(eq(businesses.id, businessId));
    await audit(tx, businessId, "system", "business", businessId, "export.ready", { files: Object.keys(files).length });
  });
  return { key, files: Object.keys(files).length };
}

export async function requestDeletion(db: Db, boss: Boss, t: TenantCtx, input: z.infer<typeof DeleteInput>) {
  if (t.role !== "owner") throw new AppError(403, "OWNER_ONLY", "only the owner can delete the business");
  return withTenant(db, t.businessId, async (tx) => {
    const [b] = await tx.select().from(businesses).where(eq(businesses.id, t.businessId));
    if (input.confirmName.trim() !== b!.name) throw new AppError(422, "CONFIRM_NAME", "type the business name exactly to confirm");
    const fresh = b!.lastExportAt && Date.now() - b!.lastExportAt.getTime() < EXPORT_FRESH_DAYS * 86_400_000;
    if (!fresh && !input.exportWaived) {
      throw new AppError(422, "EXPORT_REQUIRED", "download an export first, or confirm you don't need one");
    }
    await audit(tx, t.businessId, t.userId, "business", t.businessId, "deletion.requested", { exportWaived: input.exportWaived });
    await tx.update(businesses).set({ deletionRequestedAt: new Date() }).where(eq(businesses.id, t.businessId));
    await enqueue(boss, tx, Q.deleteBusiness, { businessId: t.businessId }, { singletonKey: `delete:${t.businessId}` });
    return { deleting: true };
  });
}

// delete-business job. Requires the privileged connection (DATABASE_ADMIN_URL):
// the only code path outside migrations that may touch audit_events this way.
export async function deleteBusiness(adminUrl: string, store: ObjectStore, businessId: string) {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const { rows } = await admin.query("select deletion_requested_at from businesses where id = $1", [businessId]);
    if (!rows[0]?.deletion_requested_at) return { result: "skipped" };   // never deletes without a recorded request

    await admin.query("BEGIN");
    const owners = await admin.query("select user_id from memberships where business_id = $1", [businessId]);
    // Components are RESTRICT on their items, so they go before the cascade.
    await admin.query("delete from assembly_components where business_id = $1", [businessId]);
    await admin.query("delete from businesses where id = $1", [businessId]);
    // A person with no business left has no account to come back to.
    await admin.query(`delete from "user" u where u.id = any($1) and not exists (select 1 from memberships m where m.user_id = u.id)`,
      [owners.rows.map((r) => r.user_id)]);
    await admin.query("COMMIT");
  } catch (e) {
    await admin.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await admin.end();
  }
  // Rows first: if this crashes the job retries and the files still go.
  const removed = await store.deletePrefix(`${businessId}/`);
  return { result: "deleted", files: removed };
}
