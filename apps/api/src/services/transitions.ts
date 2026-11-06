// The state machines (design §14). All status changes go through these
// functions: they lock the row, refuse anything not in the table, and write the
// audit event in the same transaction. Routes and jobs never set status directly.
import { and, eq } from "drizzle-orm";
import type { Tx } from "../db/client.ts";
import { invoices, quotes } from "../db/schema.ts";
import { audit } from "./audit.ts";
import { AppError, notFound } from "../http/errors.ts";

export type QuoteRow = typeof quotes.$inferSelect;
export type InvoiceRow = typeof invoices.$inferSelect;
type QuoteStatus = QuoteRow["status"];
type InvoiceStatus = InvoiceRow["status"];

export const QUOTE_TRANSITIONS: Record<QuoteStatus, readonly QuoteStatus[]> = {
  draft: ["approved"],
  approved: ["draft", "sending", "sent"],     // sent directly only by manual share
  sending: ["sent", "approved"],              // approved = permanent send failure
  sent: ["accepted", "declined", "expired", "superseded"],
  expired: ["accepted", "superseded"],
  accepted: [], declined: [], superseded: [],
};

export const INVOICE_TRANSITIONS: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  issued: ["sending", "sent"],                // sent directly only by manual share
  sending: ["sent", "issued"],
  sent: ["paid"],
  paid: ["sent"],                             // a reversing payment reopens it
  void: [],
};

function refuse(entity: string, from: string, to: string): never {
  throw new AppError(409, "ILLEGAL_TRANSITION", `a ${from} ${entity} cannot become ${to}`, { from, to });
}

export async function lockQuote(tx: Tx, businessId: string, id: string): Promise<QuoteRow> {
  const [q] = await tx.select().from(quotes).where(and(eq(quotes.businessId, businessId), eq(quotes.id, id))).for("update");
  if (!q) throw notFound("quote");
  return q;
}

export async function lockInvoice(tx: Tx, businessId: string, id: string): Promise<InvoiceRow> {
  const [i] = await tx.select().from(invoices).where(and(eq(invoices.businessId, businessId), eq(invoices.id, id))).for("update");
  if (!i) throw notFound("invoice");
  return i;
}

export function assertQuoteTransition(from: QuoteStatus, to: QuoteStatus) {
  if (!QUOTE_TRANSITIONS[from].includes(to)) refuse("quote", from, to);
}

export async function transitionQuote(
  tx: Tx, businessId: string, id: string, to: QuoteStatus, actor: string,
  set: Partial<QuoteRow> = {}, diff?: unknown,
): Promise<QuoteRow> {
  const q = await lockQuote(tx, businessId, id);
  assertQuoteTransition(q.status, to);
  const [row] = await tx.update(quotes).set({ ...set, status: to, updatedAt: new Date() })
    .where(and(eq(quotes.businessId, businessId), eq(quotes.id, id))).returning();
  await audit(tx, businessId, actor, "quote", id, `quote.${to}`, { from: q.status, ...(diff as object | undefined) });
  return row!;
}

export async function transitionInvoice(
  tx: Tx, businessId: string, id: string, to: InvoiceStatus, actor: string,
  set: Partial<InvoiceRow> = {}, diff?: unknown,
): Promise<InvoiceRow> {
  const i = await lockInvoice(tx, businessId, id);
  if (!INVOICE_TRANSITIONS[i.status].includes(to)) refuse("invoice", i.status, to);
  const [row] = await tx.update(invoices).set({ ...set, status: to, updatedAt: new Date() })
    .where(and(eq(invoices.businessId, businessId), eq(invoices.id, id))).returning();
  await audit(tx, businessId, actor, "invoice", id, `invoice.${to}`, { from: i.status, ...(diff as object | undefined) });
  return row!;
}
