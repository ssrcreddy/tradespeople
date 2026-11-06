// invoice-reminder (design §14, §20): polite at +7, firmer at +14. Re-reads the
// invoice at fire time, so paying or voiding needs no job cancelling.
import { and, eq, sql } from "drizzle-orm";
import type { InvoiceSnapshot } from "@qa/shared";
import { withTenant } from "../db/client.ts";
import { businesses, emailSuppressions, invoices } from "../db/schema.ts";
import { audit } from "../services/audit.ts";
import type { WorkerDeps } from "./deps.ts";

export interface ReminderData { businessId: string; invoiceId: string; stage: 7 | 14 }

const money = (cents: number, currency: string) => (cents / 100).toLocaleString("en-CA", { style: "currency", currency, currencyDisplay: "narrowSymbol" });

export async function invoiceReminder(d: WorkerDeps, data: ReminderData): Promise<{ result: string }> {
  const { businessId, invoiceId, stage } = data;
  const nth = stage === 7 ? 1 : 2;
  const ctx = await withTenant(d.db, businessId, async (tx) => {
    const [i] = await tx.select().from(invoices).where(and(eq(invoices.businessId, businessId), eq(invoices.id, invoiceId)));
    if (!i || i.status !== "sent" || i.paidCents >= i.amountCents) return null;
    if (i.remindersSent >= nth) return null;           // a retry after a crash
    const s = i.snapshot as InvoiceSnapshot;
    if (!s.customer.email) return null;                // shared by hand; the dashboard shows it overdue
    const [blocked] = await tx.select({ e: emailSuppressions.email }).from(emailSuppressions)
      .where(and(eq(emailSuppressions.businessId, businessId), eq(emailSuppressions.email, s.customer.email.toLowerCase())));
    if (blocked) return null;
    const [b] = await tx.select({ name: businesses.name, replyTo: businesses.replyToEmail }).from(businesses).where(eq(businesses.id, businessId));
    return { i, s, b: b! };
  });
  if (!ctx) return { result: "no-op" };
  const { i, s, b } = ctx;

  const balance = money(i.amountCents - i.paidCents, s.currency);
  const text = stage === 7
    ? `Hi ${s.customer.name},\n\nA friendly reminder that invoice ${s.number} was due on ${i.dueDate}. The balance is ${balance}. A copy is attached.\n\nIf you've already paid, thank you, and please ignore this note.\n\n${b.name}`
    : `Hi ${s.customer.name},\n\nInvoice ${s.number} is now two weeks past its due date of ${i.dueDate}, with ${balance} outstanding. Please arrange payment or reply to this email if something is wrong.\n\n${b.name}`;
  const pdf = await d.store.get(i.pdfObjectKey!);
  await d.mailer.send({
    to: s.customer.email!, fromName: b.name, replyTo: b.replyTo ?? undefined,
    subject: `Reminder: invoice ${s.number} from ${b.name}`, text,
    attachments: [{ filename: `Invoice-${s.number}.pdf`, content: pdf.body }],
    idempotencyKey: `reminder:${invoiceId}:${stage}`,
  });
  await withTenant(d.db, businessId, async (tx) => {
    await tx.update(invoices).set({ remindersSent: sql`greatest(${invoices.remindersSent}, ${nth})`, updatedAt: new Date() })
      .where(and(eq(invoices.businessId, businessId), eq(invoices.id, invoiceId)));
    await audit(tx, businessId, "system", "invoice", invoiceId, "invoice.reminder", { stage });
  });
  return { result: "sent" };
}
