// Draft quote editing (design §14, §18, §19, §21). Every change runs under a
// row lock, checks the optimistic lock version, recomputes totals with the
// engine in the same transaction, and writes an audit event.
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";
import {
  type Cents, type QtyMilli, type QuotePatch, type QuoteLineInput, type AddFromPriceBook, type PreviewRequest,
  formatQtyMilli, parseQtyMilli,
} from "@qa/shared";
import { type Db, type Tx, withTenant } from "../db/client.ts";
import { businesses, customers, jobs, priceBookItems, quoteLines, quotes } from "../db/schema.ts";
import { computeTotals, previewTotals, type EngineLine } from "./quoteEngine.ts";
import { expandItem } from "./priceBook.ts";
import { audit } from "./audit.ts";
import { assertQuoteTransition, type QuoteRow } from "./transitions.ts";
import { AppError, notFound } from "../http/errors.ts";
import type { TenantCtx } from "../http/context.ts";

type LineRow = typeof quoteLines.$inferSelect;

const DEFAULT_TERMS = "Quote valid for the period shown. Work performed to code; permit and inspection included where listed.";

// A line as the engine and the table both need it.
interface DraftLine extends EngineLine {
  description: string;
  unit: LineRow["unit"];
  priceBookItemId: string | null;
  groupKey: string | null;
  sourceKind: LineRow["sourceKind"];
  sourceQuote: string | null;
  extractedSnapshot: unknown;
  suggestions: { id: string; name: string; score: number }[] | null;
  qtyToConfirm: boolean;
}
export type { DraftLine };

const fromRow = (l: LineRow): DraftLine => ({
  description: l.description, qtyMilli: l.qtyMilli as QtyMilli, unit: l.unit,
  unitPriceCents: l.unitPriceCents as Cents | null, optional: l.optional,
  priceBookItemId: l.priceBookItemId, groupKey: l.groupKey,
  sourceKind: l.sourceKind, sourceQuote: l.sourceQuote, extractedSnapshot: l.extractedSnapshot,
  suggestions: l.suggestions, qtyToConfirm: l.qtyToConfirm,
});

export function view(q: QuoteRow, lines: LineRow[]) {
  const { businessId: _b, snapshot: _s, acceptedSnapshot: _a, pdfObjectKey, pdfSha256: _h, providerEmailId: _p, usageCounted: _u, ...rest } = q;
  return {
    ...rest,
    hasPdf: pdfObjectKey !== null,
    lines: lines.map((l) => ({
      id: l.id, description: l.description, qty: formatQtyMilli(l.qtyMilli as QtyMilli), unit: l.unit,
      unitPriceCents: l.unitPriceCents, lineTotalCents: l.lineTotalCents, priceBookItemId: l.priceBookItemId,
      needsPrice: l.needsPrice, optional: l.optional, groupKey: l.groupKey, sourceKind: l.sourceKind,
      sourceQuote: l.sourceQuote, suggestions: l.suggestions, qtyToConfirm: l.qtyToConfirm,
    })),
  };
}
export type QuoteView = ReturnType<typeof view>;

export async function loadLines(tx: Tx, businessId: string, quoteId: string) {
  return tx.select().from(quoteLines)
    .where(and(eq(quoteLines.businessId, businessId), eq(quoteLines.quoteId, quoteId)))
    .orderBy(asc(quoteLines.sort));
}

// Explicit tenant filter on every query (§11) — RLS is the second layer, not the only one.
export const quoteOf = (businessId: string, id: string) => and(eq(quotes.businessId, businessId), eq(quotes.id, id));

export async function taxesOf(tx: Tx, businessId: string) {
  const [b] = await tx.select({ taxComponents: businesses.taxComponents }).from(businesses).where(eq(businesses.id, businessId));
  return b!.taxComponents;
}

export async function createQuote(db: Db, t: TenantCtx, input: { customerId: string; jobId?: string | undefined }) {
  return withTenant(db, t.businessId, async (tx) => {
    const [c] = await tx.select({ id: customers.id }).from(customers)
      .where(and(eq(customers.businessId, t.businessId), eq(customers.id, input.customerId)));
    if (!c) throw notFound("customer");
    if (input.jobId) {
      const [j] = await tx.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.businessId, t.businessId), eq(jobs.id, input.jobId)));
      if (!j) throw notFound("job");
    }
    const q = await insertQuote(tx, t.businessId, t.userId, { customerId: input.customerId, jobId: input.jobId ?? null });
    return view(q, []);
  });
}

export async function insertQuote(tx: Tx, businessId: string, actor: string, input: { customerId: string | null; jobId: string | null }) {
  // Per-business counter, allocated in this transaction: no gaps on rollback.
  const [b] = await tx.update(businesses)
    .set({ nextQuoteNo: sql`${businesses.nextQuoteNo} + 1` })
    .where(eq(businesses.id, businessId))
    .returning({ number: sql<number>`${businesses.nextQuoteNo} - 1`, depositPct: businesses.depositPctDefault });
  const [q] = await tx.insert(quotes).values({
    businessId, customerId: input.customerId, jobId: input.jobId,
    number: b!.number, depositPct: b!.depositPct, terms: DEFAULT_TERMS, totalsComplete: true,
  }).returning();
  await audit(tx, businessId, actor, "quote", q!.id, "quote.created", { number: q!.number, jobId: input.jobId });
  return q!;
}

// A draft built by the extraction worker (§16): same storage path as any edit.
export async function createDraftFromLines(
  tx: Tx, businessId: string, input: { customerId: string | null; jobId: string }, lines: DraftLine[],
) {
  const q = await insertQuote(tx, businessId, "system", input);
  return applyLines(tx, businessId, "system", q, [], { lines, discountCents: 0, terms: q.terms }, "quote.drafted");
}

export async function listQuotes(db: Db, t: TenantCtx) {
  return withTenant(db, t.businessId, (tx) => tx.select({
    id: quotes.id, number: quotes.number, version: quotes.version, status: quotes.status,
    customerId: quotes.customerId, customerName: customers.name,
    totalCents: quotes.totalCents, totalsComplete: quotes.totalsComplete, updatedAt: quotes.updatedAt,
  }).from(quotes).leftJoin(customers, eq(customers.id, quotes.customerId))
    .where(eq(quotes.businessId, t.businessId)).orderBy(desc(quotes.updatedAt)));
}

export async function getQuote(db: Db, t: TenantCtx, id: string) {
  return withTenant(db, t.businessId, async (tx) => {
    const [q] = await tx.select().from(quotes).where(quoteOf(t.businessId, id));
    if (!q) throw notFound("quote");
    return view(q, await loadLines(tx, t.businessId, id));
  });
}

// Shared edit path: lock, check state + version, let the caller produce the new
// lines/discount/terms, recompute with the engine, store, audit.
async function editQuote(
  db: Db, t: TenantCtx, id: string, lockVersion: number, action: string,
  mutate: (tx: Tx, q: QuoteRow, current: LineRow[]) => Promise<NextDraft>,
) {
  return withTenant(db, t.businessId, async (tx) => {
    const [q] = await tx.select().from(quotes).where(quoteOf(t.businessId, id)).for("update");
    if (!q) throw notFound("quote");
    if (q.status === "sending") throw new AppError(409, "QUOTE_SENDING", "the quote is being sent; try again in a moment");
    if (q.status !== "draft" && q.status !== "approved") {
      throw new AppError(409, "QUOTE_NOT_EDITABLE", `a ${q.status} quote cannot be edited; revise it instead`);
    }
    if (lockVersion !== q.lockVersion) {
      throw new AppError(409, "STALE_QUOTE", "the quote changed since you loaded it", { currentLockVersion: q.lockVersion });
    }

    const current = await loadLines(tx, t.businessId, id);
    const next = await mutate(tx, q, current);
    const updated = await applyLines(tx, t.businessId, t.userId, q, current, next, action);
    return view(updated, await loadLines(tx, t.businessId, id));
  });
}

interface NextDraft { lines: DraftLine[]; discountCents: number; terms: string; depositPct?: number | undefined; customerId?: string | null | undefined }

// Recompute with the engine, replace the lines, store totals, audit.
export async function applyLines(
  tx: Tx, businessId: string, actor: string, q: QuoteRow, current: (LineRow | DraftLine)[],
  next: NextDraft, action: string,
): Promise<QuoteRow> {
  const id = q.id;
  const t = { businessId, userId: actor };
  const taxes = await taxesOf(tx, t.businessId);
  const cfg = { discountCents: next.discountCents as Cents, taxes };

  const preview = previewTotals(next.lines, cfg);
  if (preview.discountExceedsSubtotal) {
    throw new AppError(422, "DISCOUNT_EXCEEDS_SUBTOTAL", "the discount is larger than the priced subtotal");
  }
  // Stored totals come only from the strict path; while a line still needs a
  // price the quote stores zeros and totals_complete = false (§18).
  const strict = preview.complete ? computeTotals(next.lines, cfg) : null;

  await tx.delete(quoteLines).where(and(eq(quoteLines.businessId, t.businessId), eq(quoteLines.quoteId, id)));
  if (next.lines.length) {
    await tx.insert(quoteLines).values(next.lines.map((l, sort) => ({
      businessId: t.businessId, quoteId: id, sort,
      description: l.description, qtyMilli: l.qtyMilli, unit: l.unit,
      unitPriceCents: l.unitPriceCents, needsPrice: l.unitPriceCents === null,
      lineTotalCents: l.unitPriceCents === null ? null : preview.lines[sort]!.lineTotalCents,
      priceBookItemId: l.priceBookItemId, optional: l.optional, groupKey: l.groupKey,
      sourceKind: l.sourceKind, sourceQuote: l.sourceQuote, extractedSnapshot: l.extractedSnapshot,
      suggestions: l.suggestions, qtyToConfirm: l.qtyToConfirm,
    })));
  }

  const demoted = q.status === "approved";
  if (demoted) assertQuoteTransition("approved", "draft");
  const [updated] = await tx.update(quotes).set({
    requestedDiscountCents: next.discountCents,
    discountCents: strict?.discountCents ?? 0,
    subtotalCents: strict?.subtotalCents ?? 0,
    taxCents: strict?.taxCents ?? 0,
    totalCents: strict?.totalCents ?? 0,
    optionalTotalCents: strict?.optionalTotalCents ?? 0,
    taxes: strict?.taxes ?? [],
    totalsComplete: strict !== null,
    terms: next.terms,
    ...(next.depositPct !== undefined ? { depositPct: next.depositPct } : {}),
    ...(next.customerId !== undefined ? { customerId: next.customerId } : {}),
    lockVersion: q.lockVersion + 1,
    updatedAt: new Date(),
    // Editing an approved quote returns it to draft and discards the snapshot
    // and any PDF rendered from it (§19).
    ...(demoted ? {
      status: "draft" as const, snapshot: null, approvedBy: null, approvedAt: null,
      pdfObjectKey: null, pdfSha256: null, providerEmailId: null, lastSendError: null,
    } : {}),
  }).where(quoteOf(t.businessId, id)).returning();

  if (demoted) await audit(tx, t.businessId, t.userId, "quote", id, "quote.demoted");
  await audit(tx, t.businessId, t.userId, "quote", id, action, {
    before: summarize(current, q), after: summarize(next.lines, updated!, next.discountCents),
  });
  return updated!;
}

function summarize(lines: (LineRow | DraftLine)[], q: QuoteRow, discount = q.requestedDiscountCents) {
  return {
    lines: lines.map((l) => [l.description, formatQtyMilli(l.qtyMilli as QtyMilli), l.unitPriceCents, l.optional]),
    discountCents: discount, totalCents: q.totalCents,
  };
}

async function toDraftLines(tx: Tx, businessId: string, input: QuoteLineInput[], current: LineRow[]): Promise<DraftLine[]> {
  const ids = [...new Set(input.map((l) => l.priceBookItemId).filter((x): x is string => !!x))];
  if (ids.length) {
    const found = await tx.select({ id: priceBookItems.id }).from(priceBookItems)
      .where(and(eq(priceBookItems.businessId, businessId), inArray(priceBookItems.id, ids)));
    if (found.length !== ids.length) throw new AppError(422, "UNKNOWN_PRICE_BOOK_ITEM", "a line refers to an item not in this price book");
  }
  const byId = new Map(current.map((l) => [l.id, l]));
  return input.map((l) => {
    const prev = l.id ? byId.get(l.id) : undefined;
    if (l.id && !prev) throw new AppError(422, "UNKNOWN_LINE", "a line id does not belong to this quote");
    return {
      description: l.description, qtyMilli: parseQtyMilli(l.qty), unit: l.unit,
      unitPriceCents: l.unitPriceCents as Cents | null, optional: l.optional,
      priceBookItemId: l.priceBookItemId, groupKey: l.groupKey,
      sourceKind: prev?.sourceKind ?? "manual", sourceQuote: prev?.sourceQuote ?? null,
      extractedSnapshot: prev?.extractedSnapshot ?? null,
      // A suggestion only matters while the line is unpriced and unmatched;
      // "qty to confirm" clears once the human changes the quantity.
      suggestions: prev && l.unitPriceCents === null && !l.priceBookItemId ? prev.suggestions : null,
      qtyToConfirm: prev ? prev.qtyToConfirm && prev.qtyMilli === parseQtyMilli(l.qty) : false,
    };
  });
}

export async function patchQuote(db: Db, t: TenantCtx, id: string, patch: QuotePatch) {
  return editQuote(db, t, id, patch.lockVersion, "quote.edited", async (tx, q, current) => {
    if (patch.customerId) {
      const [c] = await tx.select({ id: customers.id }).from(customers)
        .where(and(eq(customers.businessId, t.businessId), eq(customers.id, patch.customerId)));
      if (!c) throw notFound("customer");
    }
    return {
      lines: patch.lines ? await toDraftLines(tx, t.businessId, patch.lines, current) : current.map(fromRow),
      discountCents: patch.discountCents ?? q.requestedDiscountCents,
      terms: patch.terms ?? q.terms,
      depositPct: patch.depositPct,
      customerId: patch.customerId,
    };
  });
}

export async function addFromPriceBook(db: Db, t: TenantCtx, id: string, input: z.infer<typeof AddFromPriceBook>) {
  return editQuote(db, t, id, input.lockVersion, "quote.lines_added", async (tx, q, current) => {
    const expanded = await expandItem(tx, t.businessId, input.priceBookItemId, parseQtyMilli(input.qty));
    return {
      lines: [
        ...current.map(fromRow),
        ...expanded.map((e) => ({ ...e, optional: false, sourceQuote: null, extractedSnapshot: null, suggestions: null, qtyToConfirm: false })),
      ],
      discountCents: q.requestedDiscountCents,
      terms: q.terms,
    };
  });
}

export async function preview(db: Db, t: TenantCtx, id: string, input: z.infer<typeof PreviewRequest>) {
  return withTenant(db, t.businessId, async (tx) => {
    const [q] = await tx.select({ id: quotes.id }).from(quotes).where(quoteOf(t.businessId, id));
    if (!q) throw notFound("quote");
    const lines = input.lines.map((l) => ({
      qtyMilli: parseQtyMilli(l.qty), unitPriceCents: l.unitPriceCents as Cents | null, optional: l.optional,
    }));
    const p = previewTotals(lines, { discountCents: input.discountCents as Cents, taxes: await taxesOf(tx, t.businessId) });
    return {
      complete: p.complete, unpricedLines: p.unpricedLines, discountExceedsSubtotal: p.discountExceedsSubtotal,
      lineTotalsCents: p.lines.map((l) => (l.unitPriceCents === null ? null : l.lineTotalCents)),
      subtotalCents: p.subtotalCents, discountCents: p.discountCents, taxes: p.taxes,
      taxCents: p.taxCents, totalCents: p.totalCents, optionalTotalCents: p.optionalTotalCents,
    };
  });
}
