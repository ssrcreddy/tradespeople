// Approve → send / share → outcome → revise (design §14, §19).
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { type Cents, type QtyMilli, type QuoteSnapshot, quoteNumber } from "@qa/shared";
import { type Db, type Tx, withTenant } from "../db/client.ts";
import { businesses, customers, emailSuppressions, quoteLines, quotes, usageCounters } from "../db/schema.ts";
import { enqueue, Q, type Boss } from "../queue.ts";
import type { ObjectStore } from "../storage.ts";
import { computeTotals } from "./quoteEngine.ts";
import { applyLines, loadLines, quoteOf, view, type DraftLine } from "./quotes.ts";
import { lockQuote, transitionQuote, assertQuoteTransition, type QuoteRow } from "./transitions.ts";
import { renderQuotePdf, sha256 } from "./pdf.ts";
import { addDays, todayIn } from "./dates.ts";
import { audit } from "./audit.ts";
import { AppError } from "../http/errors.ts";
import type { TenantCtx } from "../http/context.ts";

export const ApproveInput = z.object({ lockVersion: z.number().int().nonnegative() });
export const OutcomeInput = z.object({
  outcome: z.enum(["accepted", "declined"]),
  acceptedOptionalLineIds: z.array(z.uuid()).max(200).default([]),
});

const monthOf = sql`date_trunc('month', current_date)::date`;

export async function approve(db: Db, t: TenantCtx, id: string, input: z.infer<typeof ApproveInput>) {
  return withTenant(db, t.businessId, async (tx) => {
    const q = await lockQuote(tx, t.businessId, id);
    assertQuoteTransition(q.status, "approved");
    if (input.lockVersion !== q.lockVersion) {
      throw new AppError(409, "STALE_QUOTE", "the quote changed since you loaded it", { currentLockVersion: q.lockVersion });
    }
    const lines = await loadLines(tx, t.businessId, id);
    const [b] = await tx.select().from(businesses).where(eq(businesses.id, t.businessId));
    const business = b!;
    const [customer] = q.customerId
      ? await tx.select().from(customers).where(and(eq(customers.businessId, t.businessId), eq(customers.id, q.customerId)))
      : [];

    // All preconditions at once, so the owner sees everything that blocks approval (§14).
    const blockers: string[] = [];
    if (lines.some((l) => l.needsPrice)) blockers.push("UNPRICED_LINES");
    if (!lines.some((l) => !l.optional)) blockers.push("NO_LINES");
    if (!customer?.name || (!customer.email && !customer.phone)) blockers.push("NO_CUSTOMER_CONTACT");
    if (business.taxComponents.length === 0) blockers.push("NO_TAX_CONFIG");
    const [usage] = await tx.select({ n: usageCounters.quotesApproved }).from(usageCounters)
      .where(and(eq(usageCounters.businessId, t.businessId), eq(usageCounters.month, monthOf)));
    if (!q.usageCounted && business.monthlyQuoteLimit !== null && (usage?.n ?? 0) >= business.monthlyQuoteLimit) {
      blockers.push("PLAN_LIMIT_REACHED");
    }
    if (blockers.length) {
      throw new AppError(422, blockers[0]!, "this quote can't be approved yet", { blockers });
    }

    // The approval-time recompute is authoritative (§18).
    const totals = computeTotals(lines.map((l) => ({
      ...l, qtyMilli: l.qtyMilli as QtyMilli, unitPriceCents: l.unitPriceCents as Cents,
    })), { discountCents: q.requestedDiscountCents as Cents, taxes: business.taxComponents });

    const issuedOn = todayIn(business.timezone);
    const snapshot: QuoteSnapshot = {
      templateVersion: 1, number: quoteNumber(q.number), version: q.version, currency: business.currency,
      business: { name: business.name },
      customer: { name: customer!.name, email: customer!.email, phone: customer!.phone, siteAddress: customer!.siteAddress },
      lines: totals.lines.map((l) => ({
        description: l.description, qtyMilli: l.qtyMilli, unit: l.unit, unitPriceCents: l.unitPriceCents as number,
        lineTotalCents: l.lineTotalCents, optional: l.optional, groupKey: l.groupKey,
      })),
      subtotalCents: totals.subtotalCents, discountCents: totals.discountCents, taxes: totals.taxes,
      taxCents: totals.taxCents, totalCents: totals.totalCents, optionalTotalCents: totals.optionalTotalCents,
      depositPct: q.depositPct, collapseAssemblies: business.collapseAssemblies, terms: q.terms,
      issuedOn, expiresOn: addDays(issuedOn, business.quoteExpiryDays),
    };

    if (!q.usageCounted) {
      await tx.insert(usageCounters).values({ businessId: t.businessId, month: monthOf, quotesApproved: 1 })
        .onConflictDoUpdate({
          target: [usageCounters.businessId, usageCounters.month],
          set: { quotesApproved: sql`${usageCounters.quotesApproved} + 1` },
        });
    }
    const row = await transitionQuote(tx, t.businessId, id, "approved", t.userId, {
      snapshot, approvedBy: t.userId, approvedAt: new Date(), usageCounted: true, lockVersion: q.lockVersion + 1,
      discountCents: totals.discountCents, subtotalCents: totals.subtotalCents, taxCents: totals.taxCents,
      totalCents: totals.totalCents, optionalTotalCents: totals.optionalTotalCents, taxes: totals.taxes, totalsComplete: true,
    });
    return view(row, lines);
  });
}

async function assertSendable(tx: Tx, businessId: string, email: string | null) {
  if (!email) throw new AppError(422, "NO_CUSTOMER_EMAIL", "this customer has no email address; download the PDF and share it instead");
  const [s] = await tx.select({ reason: emailSuppressions.reason }).from(emailSuppressions)
    .where(and(eq(emailSuppressions.businessId, businessId), eq(emailSuppressions.email, email.toLowerCase())));
  if (s) throw new AppError(422, "RECIPIENT_SUPPRESSED", `this address is blocked after a ${s.reason}; correct it or share the PDF yourself`);
}
export { assertSendable };

export async function send(db: Db, boss: Boss, t: TenantCtx, id: string) {
  return withTenant(db, t.businessId, async (tx) => {
    const q = await lockQuote(tx, t.businessId, id);
    assertQuoteTransition(q.status, "sending");
    await assertSendable(tx, t.businessId, (q.snapshot as QuoteSnapshot).customer.email);
    const row = await transitionQuote(tx, t.businessId, id, "sending", t.userId, { lastSendError: null });
    await enqueue(boss, tx, Q.sendDocument, { businessId: t.businessId, kind: "quote", documentId: id }, { singletonKey: `send:quote:${id}` });
    return view(row, await loadLines(tx, t.businessId, id));
  });
}

export const pdfKey = (businessId: string, name: string, bytes: Buffer) =>
  `${businessId}/documents/${name}-${sha256(bytes).slice(0, 12)}.pdf`;

// Rendered once per approved version; the stored bytes are the document (§19).
export async function ensureQuotePdf(tx: Tx, store: ObjectStore, q: QuoteRow): Promise<QuoteRow> {
  if (q.pdfObjectKey) return q;
  const s = q.snapshot as QuoteSnapshot;
  const bytes = await renderQuotePdf(s);
  const key = pdfKey(q.businessId, `quote-${s.number}-v${s.version}`, bytes);
  await store.put(key, bytes, "application/pdf");
  const [row] = await tx.update(quotes).set({ pdfObjectKey: key, pdfSha256: sha256(bytes) })
    .where(quoteOf(q.businessId, q.id)).returning();
  return row!;
}

// For customers who only text: the owner downloads the PDF and sends it themselves.
export async function share(db: Db, store: ObjectStore, t: TenantCtx, id: string) {
  return withTenant(db, t.businessId, async (tx) => {
    const q = await lockQuote(tx, t.businessId, id);
    // sending→sent is the worker's step; a person may only share an approved quote.
    if (q.status !== "approved") throw new AppError(409, "ILLEGAL_TRANSITION", `a ${q.status} quote cannot be shared`);
    await ensureQuotePdf(tx, store, q);
    const row = await transitionQuote(tx, t.businessId, id, "sent", t.userId, { sentAt: new Date(), sentVia: "manual_share" }, { via: "manual_share" });
    return { ...view(row, await loadLines(tx, t.businessId, id)), pdfUrl: `/quotes/${id}/pdf` };
  });
}

export async function outcome(db: Db, t: TenantCtx, id: string, input: z.infer<typeof OutcomeInput>) {
  return withTenant(db, t.businessId, async (tx) => {
    const q = await lockQuote(tx, t.businessId, id);
    assertQuoteTransition(q.status, input.outcome);
    if (input.outcome === "declined") {
      const row = await transitionQuote(tx, t.businessId, id, "declined", t.userId, { outcomeAt: new Date() });
      return view(row, await loadLines(tx, t.businessId, id));
    }

    // Chosen optional lines become part of the job. Totals are recomputed with
    // the tax rates the customer was quoted, not today's settings.
    const lines = await loadLines(tx, t.businessId, id);
    const chosen = new Set(input.acceptedOptionalLineIds);
    for (const lineId of chosen) {
      if (!lines.some((l) => l.id === lineId && l.optional)) {
        throw new AppError(422, "NOT_AN_OPTIONAL_LINE", "an accepted line is not an optional line on this quote");
      }
    }
    if (chosen.size) {
      for (const lineId of chosen) {
        await tx.update(quoteLines).set({ optional: false })
          .where(and(eq(quoteLines.businessId, t.businessId), eq(quoteLines.id, lineId)));
      }
    }
    const s = q.snapshot as QuoteSnapshot;
    const after = lines.map((l) => ({ ...l, optional: l.optional && !chosen.has(l.id) }));
    const totals = computeTotals(after.map((l) => ({
      ...l, qtyMilli: l.qtyMilli as QtyMilli, unitPriceCents: l.unitPriceCents as Cents,
    })), { discountCents: s.discountCents as Cents, taxes: s.taxes.map(({ amountCents: _a, ...c }) => c) });
    const accepted: QuoteSnapshot = {
      ...s,
      lines: totals.lines.map((l) => ({
        description: l.description, qtyMilli: l.qtyMilli, unit: l.unit, unitPriceCents: l.unitPriceCents as number,
        lineTotalCents: l.lineTotalCents, optional: l.optional, groupKey: l.groupKey,
      })),
      subtotalCents: totals.subtotalCents, taxes: totals.taxes, taxCents: totals.taxCents,
      totalCents: totals.totalCents, optionalTotalCents: totals.optionalTotalCents,
    };
    const row = await transitionQuote(tx, t.businessId, id, "accepted", t.userId, {
      acceptedSnapshot: accepted, outcomeAt: new Date(),
      subtotalCents: totals.subtotalCents, taxCents: totals.taxCents, totalCents: totals.totalCents,
      optionalTotalCents: totals.optionalTotalCents, taxes: totals.taxes,
    }, { acceptedOptionalLines: chosen.size });
    return view(row, await loadLines(tx, t.businessId, id));
  });
}

// A sent quote is never edited in place: it is superseded by the next version
// of the same number (§19).
export async function revise(db: Db, t: TenantCtx, id: string) {
  return withTenant(db, t.businessId, async (tx) => {
    const q = await lockQuote(tx, t.businessId, id);
    assertQuoteTransition(q.status, "superseded");
    const lines = await loadLines(tx, t.businessId, id);
    await transitionQuote(tx, t.businessId, id, "superseded", t.userId);
    const [next] = await tx.insert(quotes).values({
      businessId: t.businessId, jobId: q.jobId, customerId: q.customerId, number: q.number, version: q.version + 1,
      parentQuoteId: q.id, terms: q.terms, depositPct: q.depositPct, totalsComplete: true, usageCounted: true,
    }).returning();
    const draftLines: DraftLine[] = lines.map((l) => ({
      description: l.description, qtyMilli: l.qtyMilli as QtyMilli, unit: l.unit, unitPriceCents: l.unitPriceCents as Cents | null,
      optional: l.optional, priceBookItemId: l.priceBookItemId, groupKey: l.groupKey, sourceKind: l.sourceKind,
      sourceQuote: l.sourceQuote, extractedSnapshot: l.extractedSnapshot, suggestions: null, qtyToConfirm: false,
    }));
    const updated = await applyLines(tx, t.businessId, t.userId, next!, [],
      { lines: draftLines, discountCents: q.requestedDiscountCents, terms: q.terms }, "quote.revised");
    await audit(tx, t.businessId, t.userId, "quote", next!.id, "quote.revision_of", { parentQuoteId: q.id });
    return view(updated, await loadLines(tx, t.businessId, next!.id));
  });
}

// Quotes past their date (expiry-sweep, §14).
export async function expireQuote(tx: Tx, businessId: string, id: string) {
  return transitionQuote(tx, businessId, id, "expired", "system");
}

