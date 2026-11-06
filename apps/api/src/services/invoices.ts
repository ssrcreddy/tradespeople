// Invoice conversion and payments (design §20). An invoice copies the accepted
// snapshot — it is never re-priced — and a deposit + final pair always sums to
// the quote total exactly.
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { type Cents, type InvoiceSnapshot, type QuoteSnapshot, invoiceNumber, quoteNumber } from "@qa/shared";
import { type Db, type Tx, withTenant } from "../db/client.ts";
import { businesses, invoices, payments, quotes } from "../db/schema.ts";
import { enqueue, Q, type Boss } from "../queue.ts";
import type { ObjectStore } from "../storage.ts";
import { splitDeposit, splitTaxes } from "./quoteEngine.ts";
import { lockInvoice, lockQuote, transitionInvoice, type InvoiceRow } from "./transitions.ts";
import { assertSendable, pdfKey } from "./quoteActions.ts";
import { renderInvoicePdf, sha256 } from "./pdf.ts";
import { addDays, localHourToInstant, todayIn } from "./dates.ts";
import { audit } from "./audit.ts";
import { AppError, notFound } from "../http/errors.ts";
import type { TenantCtx } from "../http/context.ts";

export const ConvertInput = z.object({ kind: z.enum(["deposit", "final"]).default("final") });
export const PaymentInput = z.object({
  amountCents: z.number().int().refine((n) => n !== 0, "amount cannot be zero"),   // negative = reversal
  method: z.string().trim().min(1).max(40),
  receivedOn: z.iso.date(),
  note: z.string().max(500).nullable().default(null),
  idempotencyKey: z.string().min(8).max(100),
});

const invoiceOf = (businessId: string, id: string) => and(eq(invoices.businessId, businessId), eq(invoices.id, id));

function view(i: InvoiceRow, today: string) {
  const { businessId: _b, snapshot, pdfObjectKey, pdfSha256: _s, providerEmailId: _p, ...rest } = i;
  const s = snapshot as InvoiceSnapshot;
  return {
    ...rest, ref: s.number, quoteRef: s.quoteRef, customerName: s.customer.name, customerEmail: s.customer.email,
    balanceCents: i.amountCents - i.paidCents,
    // Derived, never stored (§20).
    overdue: i.status === "sent" && i.dueDate !== null && i.dueDate < today && i.paidCents < i.amountCents,
    hasPdf: pdfObjectKey !== null,
  };
}

async function timezoneOf(tx: Tx, businessId: string) {
  const [b] = await tx.select({ tz: businesses.timezone }).from(businesses).where(eq(businesses.id, businessId));
  return b!.tz;
}

export async function convert(db: Db, t: TenantCtx, quoteId: string, input: z.infer<typeof ConvertInput>) {
  return withTenant(db, t.businessId, async (tx) => {
    const q = await lockQuote(tx, t.businessId, quoteId);
    if (q.status !== "accepted") throw new AppError(409, "NOT_ACCEPTED", "only an accepted quote can be invoiced");
    const mine = await tx.select().from(invoices).where(and(eq(invoices.businessId, t.businessId), eq(invoices.quoteId, quoteId)));
    const tz = await timezoneOf(tx, t.businessId);
    const today = todayIn(tz);
    const existing = mine.find((i) => i.kind === input.kind);
    if (existing) return view(existing, today);      // idempotent per (quote, kind)

    const s = (q.acceptedSnapshot ?? q.snapshot) as QuoteSnapshot;
    const deposit = mine.find((i) => i.kind === "deposit");
    const final = mine.find((i) => i.kind === "final");
    if (input.kind === "deposit" && final) throw new AppError(409, "FINAL_EXISTS", "the final invoice already exists");
    if (input.kind === "deposit" && s.depositPct === 0) throw new AppError(422, "NO_DEPOSIT", "this quote has no deposit");

    // Per-business counter, allocated in this transaction: no gaps on rollback.
    const [n] = await tx.update(businesses).set({ nextInvoiceNo: sql`${businesses.nextInvoiceNo} + 1` })
      .where(eq(businesses.id, t.businessId)).returning({ number: sql<number>`${businesses.nextInvoiceNo} - 1` });
    const number = invoiceNumber(n!.number);
    const common = {
      templateVersion: 1 as const, number, quoteRef: `${quoteNumber(q.number)} v${q.version}`, currency: s.currency,
      business: s.business, customer: s.customer, collapseAssemblies: s.collapseAssemblies, terms: s.terms, issuedOn: today,
    };

    let snapshot: InvoiceSnapshot;
    let amountCents: number;
    let taxCents: number;
    if (input.kind === "deposit") {
      const d = splitDeposit({ totalCents: s.totalCents as Cents, taxCents: s.taxCents as Cents }, s.depositPct);
      const preTax = d.depositTotalCents - d.depositTaxCents;
      snapshot = {
        ...common, kind: "deposit",
        lines: [{
          description: `Deposit — ${s.depositPct}% of ${common.quoteRef}`, qtyMilli: 1000, unit: "flat",
          unitPriceCents: preTax, lineTotalCents: preTax, optional: false, groupKey: null,
        }],
        subtotalCents: preTax, discountCents: 0, taxes: splitTaxes(s.taxes, s.depositPct, d.depositTaxCents),
        taxCents: d.depositTaxCents, totalCents: d.depositTotalCents,
        lessDepositCents: 0, lessDepositRef: null, amountDueCents: d.depositTotalCents,
      };
      amountCents = d.depositTotalCents;
      taxCents = d.depositTaxCents;
    } else {
      const less = deposit?.amountCents ?? 0;
      snapshot = {
        ...common, kind: "final",
        lines: s.lines.filter((l) => !l.optional),
        subtotalCents: s.subtotalCents, discountCents: s.discountCents, taxes: s.taxes,
        taxCents: s.taxCents, totalCents: s.totalCents,
        lessDepositCents: less, lessDepositRef: deposit ? (deposit.snapshot as InvoiceSnapshot).number : null,
        amountDueCents: s.totalCents - less,
      };
      amountCents = s.totalCents - less;
      taxCents = s.taxCents - (deposit?.taxCents ?? 0);
    }

    const [row] = await tx.insert(invoices).values({
      businessId: t.businessId, quoteId, kind: input.kind, number: n!.number, amountCents, taxCents, snapshot,
    }).returning();
    await audit(tx, t.businessId, t.userId, "invoice", row!.id, "invoice.issued", { number, kind: input.kind, amountCents });
    return view(row!, today);
  });
}

// Due date counts from the day it is sent, in the business's timezone (§20).
async function dueDateFor(tx: Tx, businessId: string) {
  const [b] = await tx.select({ tz: businesses.timezone, terms: businesses.termsDays }).from(businesses).where(eq(businesses.id, businessId));
  return addDays(todayIn(b!.tz), b!.terms);
}

export async function sendInvoice(db: Db, boss: Boss, t: TenantCtx, id: string) {
  return withTenant(db, t.businessId, async (tx) => {
    const i = await lockInvoice(tx, t.businessId, id);
    if (i.status === "issued") await assertSendable(tx, t.businessId, (i.snapshot as InvoiceSnapshot).customer.email);
    const row = await transitionInvoice(tx, t.businessId, id, "sending", t.userId, {
      dueDate: i.pdfObjectKey ? i.dueDate : await dueDateFor(tx, t.businessId), lastSendError: null,
    });
    await enqueue(boss, tx, Q.sendDocument, { businessId: t.businessId, kind: "invoice", documentId: id }, { singletonKey: `send:invoice:${id}` });
    return view(row, todayIn(await timezoneOf(tx, t.businessId)));
  });
}

export async function ensureInvoicePdf(tx: Tx, store: ObjectStore, i: InvoiceRow): Promise<InvoiceRow> {
  if (i.pdfObjectKey) return i;
  const s = i.snapshot as InvoiceSnapshot;
  const bytes = await renderInvoicePdf(s, i.dueDate!);
  const key = pdfKey(i.businessId, `invoice-${s.number}`, bytes);
  await store.put(key, bytes, "application/pdf");
  const [row] = await tx.update(invoices).set({ pdfObjectKey: key, pdfSha256: sha256(bytes) })
    .where(invoiceOf(i.businessId, i.id)).returning();
  return row!;
}

// Reminders at due+7 and due+14, 09:00 business-local (§20). Re-checked at fire time.
export async function scheduleReminders(boss: Boss, tx: Tx, i: InvoiceRow) {
  const tz = await timezoneOf(tx, i.businessId);
  for (const stage of [7, 14] as const) {
    await enqueue(boss, tx, Q.invoiceReminder, { businessId: i.businessId, invoiceId: i.id, stage }, {
      startAfter: localHourToInstant(addDays(i.dueDate!, stage), 9, tz),
      singletonKey: `reminder:${i.id}:${stage}`,
    });
  }
}

export async function shareInvoice(db: Db, boss: Boss, store: ObjectStore, t: TenantCtx, id: string) {
  return withTenant(db, t.businessId, async (tx) => {
    const i = await lockInvoice(tx, t.businessId, id);
    if (i.status !== "issued") throw new AppError(409, "ILLEGAL_TRANSITION", `a ${i.status} invoice cannot be shared`);
    const dueDate = await dueDateFor(tx, t.businessId);
    await tx.update(invoices).set({ dueDate }).where(invoiceOf(t.businessId, id));
    await ensureInvoicePdf(tx, store, { ...i, dueDate });
    const row = await transitionInvoice(tx, t.businessId, id, "sent", t.userId, { sentAt: new Date(), sentVia: "manual_share" }, { via: "manual_share" });
    await scheduleReminders(boss, tx, row);
    return { ...view(row, todayIn(await timezoneOf(tx, t.businessId))), pdfUrl: `/invoices/${id}/pdf` };
  });
}

export async function recordPayment(db: Db, t: TenantCtx, id: string, input: z.infer<typeof PaymentInput>) {
  return withTenant(db, t.businessId, async (tx) => {
    const i = await lockInvoice(tx, t.businessId, id);
    const today = todayIn(await timezoneOf(tx, t.businessId));
    const [dupe] = await tx.select({ id: payments.id }).from(payments)
      .where(and(eq(payments.businessId, t.businessId), eq(payments.idempotencyKey, input.idempotencyKey)));
    if (dupe) return view(i, today);                 // a double-tap records one payment
    if (i.status !== "sent" && i.status !== "paid") throw new AppError(409, "NOT_SENT", "record payments on a sent invoice");
    const paid = i.paidCents + input.amountCents;
    if (paid > i.amountCents) throw new AppError(422, "OVERPAYMENT", "this is more than the balance");
    if (paid < 0) throw new AppError(422, "REVERSAL_TOO_LARGE", "this reverses more than was paid");

    await tx.insert(payments).values({ ...input, businessId: t.businessId, invoiceId: id, recordedBy: t.userId });
    await audit(tx, t.businessId, t.userId, "invoice", id, "invoice.payment", { amountCents: input.amountCents, method: input.method });
    const fullyPaid = paid >= i.amountCents;
    if (fullyPaid && i.status === "sent") return view(await transitionInvoice(tx, t.businessId, id, "paid", t.userId, { paidCents: paid }), today);
    if (!fullyPaid && i.status === "paid") return view(await transitionInvoice(tx, t.businessId, id, "sent", t.userId, { paidCents: paid }), today);
    const [row] = await tx.update(invoices).set({ paidCents: paid, updatedAt: new Date() }).where(invoiceOf(t.businessId, id)).returning();
    return view(row!, today);
  });
}

export async function listInvoices(db: Db, t: TenantCtx) {
  return withTenant(db, t.businessId, async (tx) => {
    const today = todayIn(await timezoneOf(tx, t.businessId));
    const rows = await tx.select().from(invoices).where(eq(invoices.businessId, t.businessId)).orderBy(desc(invoices.number));
    return rows.map((r) => view(r, today));
  });
}

export async function getInvoice(db: Db, t: TenantCtx, id: string) {
  return withTenant(db, t.businessId, async (tx) => {
    const [i] = await tx.select().from(invoices).where(invoiceOf(t.businessId, id));
    if (!i) throw notFound("invoice");
    const paymentRows = await tx.select({
      id: payments.id, amountCents: payments.amountCents, method: payments.method, receivedOn: payments.receivedOn, note: payments.note,
    }).from(payments).where(and(eq(payments.businessId, t.businessId), eq(payments.invoiceId, id))).orderBy(asc(payments.createdAt));
    const s = i.snapshot as InvoiceSnapshot;
    return { ...view(i, todayIn(await timezoneOf(tx, t.businessId))), payments: paymentRows, totalCents: s.totalCents, lessDepositCents: s.lessDepositCents };
  });
}

export async function invoicesForQuote(db: Db, t: TenantCtx, quoteId: string) {
  return withTenant(db, t.businessId, async (tx) => {
    const [q] = await tx.select({ id: quotes.id }).from(quotes).where(and(eq(quotes.businessId, t.businessId), eq(quotes.id, quoteId)));
    if (!q) throw notFound("quote");
    const today = todayIn(await timezoneOf(tx, t.businessId));
    const rows = await tx.select().from(invoices).where(and(eq(invoices.businessId, t.businessId), eq(invoices.quoteId, quoteId))).orderBy(asc(invoices.number));
    return rows.map((r) => view(r, today));
  });
}

