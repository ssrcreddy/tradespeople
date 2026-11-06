// send-document (design §14, §19): render once, store the bytes, email those
// stored bytes. Safe to retry at any point: a stored PDF is reused, a recorded
// provider id means the email already went, and the idempotency key stops a
// repeat if the worker died between the provider call and the commit.
import { eq } from "drizzle-orm";
import type { InvoiceSnapshot, QuoteSnapshot } from "@qa/shared";
import { withTenant } from "../db/client.ts";
import { businesses } from "../db/schema.ts";
import { ensureQuotePdf } from "../services/quoteActions.ts";
import { ensureInvoicePdf, scheduleReminders } from "../services/invoices.ts";
import { lockInvoice, lockQuote, transitionInvoice, transitionQuote } from "../services/transitions.ts";
import { notifyOwners } from "../services/notify.ts";
import type { WorkerDeps } from "./deps.ts";

export interface SendData { businessId: string; kind: "quote" | "invoice"; documentId: string }

async function replyToOf(d: WorkerDeps, businessId: string) {
  return withTenant(d.db, businessId, async (tx) => {
    const [b] = await tx.select({ replyTo: businesses.replyToEmail, name: businesses.name }).from(businesses).where(eq(businesses.id, businessId));
    return b!;
  });
}

const money = (cents: number, currency: string) => (cents / 100).toLocaleString("en-CA", { style: "currency", currency, currencyDisplay: "narrowSymbol" });

export async function sendDocument(d: WorkerDeps, data: SendData): Promise<{ result: string }> {
  const { businessId, kind, documentId } = data;
  const b = await replyToOf(d, businessId);

  if (kind === "quote") {
    // Step 1: render + store, under the row lock, only while still `sending`.
    const q = await withTenant(d.db, businessId, async (tx) => {
      const row = await lockQuote(tx, businessId, documentId);
      return row.status === "sending" ? ensureQuotePdf(tx, d.store, row) : null;
    });
    if (!q) return { result: "skipped" };
    const s = q.snapshot as QuoteSnapshot;
    const pdf = await d.store.get(q.pdfObjectKey!);

    // Step 2: email the stored bytes.
    const providerEmailId = q.providerEmailId ?? (await d.mailer.send({
      to: s.customer.email!, fromName: b.name, replyTo: b.replyTo ?? undefined,
      subject: `Quote ${s.number} from ${b.name}`,
      text: `Hi ${s.customer.name},\n\nYour quote from ${b.name} is attached: ${money(s.totalCents, s.currency)} including tax, valid until ${s.expiresOn}.\n\nReply to this email with any questions, or to accept.\n\n${b.name}`,
      attachments: [{ filename: `Quote-${s.number}-v${s.version}.pdf`, content: pdf.body }],
      idempotencyKey: `quote:${documentId}:v${s.version}:${q.pdfSha256!.slice(0, 12)}`,
    })).id;

    // Step 3: commit.
    await withTenant(d.db, businessId, (tx) => transitionQuote(tx, businessId, documentId, "sent", "system", {
      providerEmailId, sentAt: new Date(), sentVia: "email",
    }, { via: "email", sha256: q.pdfSha256 }));
    return { result: "sent" };
  }

  const i = await withTenant(d.db, businessId, async (tx) => {
    const row = await lockInvoice(tx, businessId, documentId);
    return row.status === "sending" ? ensureInvoicePdf(tx, d.store, row) : null;
  });
  if (!i) return { result: "skipped" };
  const s = i.snapshot as InvoiceSnapshot;
  const pdf = await d.store.get(i.pdfObjectKey!);
  const providerEmailId = i.providerEmailId ?? (await d.mailer.send({
    to: s.customer.email!, fromName: b.name, replyTo: b.replyTo ?? undefined,
    subject: `Invoice ${s.number} from ${b.name}`,
    text: `Hi ${s.customer.name},\n\nYour invoice from ${b.name} is attached: ${money(i.amountCents, s.currency)} due ${i.dueDate}.\n\nThank you,\n${b.name}`,
    attachments: [{ filename: `Invoice-${s.number}.pdf`, content: pdf.body }],
    idempotencyKey: `invoice:${documentId}:${i.pdfSha256!.slice(0, 12)}`,
  })).id;
  await withTenant(d.db, businessId, async (tx) => {
    const row = await transitionInvoice(tx, businessId, documentId, "sent", "system", {
      providerEmailId, sentAt: new Date(), sentVia: "email",
    }, { via: "email", sha256: i.pdfSha256 });
    await scheduleReminders(d.boss, tx, row);
  });
  return { result: "sent" };
}

// send-failed: retries exhausted. Back to the sendable state, error visible,
// owner told, Send still available (§14, §23).
export async function sendFailed(d: WorkerDeps, data: SendData) {
  const { businessId, kind, documentId } = data;
  return withTenant(d.db, businessId, async (tx) => {
    const lastSendError = "the email could not be sent after several tries";
    if (kind === "quote") {
      const q = await lockQuote(tx, businessId, documentId);
      if (q.status !== "sending") return { result: "skipped" };
      await transitionQuote(tx, businessId, documentId, "approved", "system", { lastSendError });
    } else {
      const i = await lockInvoice(tx, businessId, documentId);
      if (i.status !== "sending") return { result: "skipped" };
      await transitionInvoice(tx, businessId, documentId, "issued", "system", { lastSendError });
    }
    await notifyOwners(d.boss, tx, businessId, "send_failed", `${kind}:${documentId}:${Date.now()}`);
    return { result: "returned" };
  });
}

