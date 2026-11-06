// The quote engine (design §18): pure functions over integer cents and integer
// milli-quantities. The only place in the system allowed to produce a total.
// Imports nothing but the shared money helpers — no DB, no LLM, no I/O.
import {
  type Cents, type QtyMilli, type RatePpm, type TaxComponent,
  mulQtyRate, applyRatePpm, sumCents, pctOf,
} from "@qa/shared";

export interface EngineLine {
  qtyMilli: QtyMilli;
  unitPriceCents: Cents | null;   // null = needs price
  optional: boolean;
}

export interface TaxAmount extends TaxComponent { amountCents: Cents }

export interface Totals<L extends EngineLine = EngineLine> {
  lines: (L & { lineTotalCents: Cents })[];
  subtotalCents: Cents;           // counted (non-optional) lines only
  discountCents: Cents;
  taxes: TaxAmount[];
  taxCents: Cents;
  totalCents: Cents;
  optionalTotalCents: Cents;      // shown as "optional extras", not in total
}

export type EngineErrorCode = "UNPRICED_LINE" | "DISCOUNT_EXCEEDS_SUBTOTAL";

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  constructor(code: EngineErrorCode) {
    super(code);
    this.code = code;
  }
}

export interface EngineConfig { discountCents: Cents; taxes: readonly TaxComponent[] }

// Strict path: the only function whose output may be stored on a quote.
export function computeTotals<L extends EngineLine>(lines: readonly L[], cfg: EngineConfig): Totals<L> {
  if (lines.some((l) => l.unitPriceCents === null)) throw new EngineError("UNPRICED_LINE");

  const priced = lines.map((l) => ({
    ...l,
    // round half-up per LINE, not per quote — matches invoice norms
    lineTotalCents: mulQtyRate(l.qtyMilli, l.unitPriceCents as Cents),
  }));
  const subtotal = sumCents(priced.filter((l) => !l.optional).map((l) => l.lineTotalCents));
  if (cfg.discountCents > subtotal) throw new EngineError("DISCOUNT_EXCEEDS_SUBTOTAL");

  const taxable = (subtotal - cfg.discountCents) as Cents;   // bound enforced above, no max(0, …)
  const taxes = cfg.taxes.map((t) => ({
    ...t,
    amountCents: applyRatePpm(taxable, t.ratePpm as RatePpm),  // each component rounded on its own
  }));
  const tax = sumCents(taxes.map((t) => t.amountCents));
  const optional = sumCents(priced.filter((l) => l.optional).map((l) => l.lineTotalCents));

  return {
    lines: priced, subtotalCents: subtotal, discountCents: cfg.discountCents,
    taxes, taxCents: tax, totalCents: (taxable + tax) as Cents, optionalTotalCents: optional,
  };
}

export interface Preview<L extends EngineLine = EngineLine> extends Totals<L> {
  complete: boolean;              // false while any line is unpriced or the discount is too large
  unpricedLines: number;
  discountExceedsSubtotal: boolean;
}

// Display-only path for the review screen: unpriced lines count as zero and the
// result labels itself incomplete. Never stored.
export function previewTotals<L extends EngineLine>(lines: readonly L[], cfg: EngineConfig): Preview<L> {
  const unpriced = lines.filter((l) => l.unitPriceCents === null).length;
  const asPriced = lines.map((l) => ({ ...l, unitPriceCents: (l.unitPriceCents ?? 0) as Cents }));
  const counted = sumCents(asPriced.filter((l) => !l.optional).map((l) => mulQtyRate(l.qtyMilli, l.unitPriceCents)));
  const tooMuch = cfg.discountCents > counted;
  const t = computeTotals(asPriced, { ...cfg, discountCents: (tooMuch ? counted : cfg.discountCents) as Cents });
  return {
    ...t,
    lines: t.lines.map((l, i) => ({ ...l, unitPriceCents: lines[i]!.unitPriceCents })) as Totals<L>["lines"],
    complete: unpriced === 0 && !tooMuch,
    unpricedLines: unpriced,
    discountExceedsSubtotal: tooMuch,
  };
}

// Deposit: share of the tax-inclusive total, tax split pro-rata so the deposit
// invoice can show it. Remainders land on the balance, so deposit + balance
// always equals the quote total exactly.
export function splitDeposit(t: Pick<Totals, "totalCents" | "taxCents">, pct: number) {
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) throw new RangeError("deposit pct must be an integer 0–100");
  const depositTotal = pctOf(t.totalCents, pct);
  const depositTax = pctOf(t.taxCents, pct);
  return {
    depositTotalCents: depositTotal,
    depositTaxCents: depositTax,
    balanceTotalCents: (t.totalCents - depositTotal) as Cents,
    balanceTaxCents: (t.taxCents - depositTax) as Cents,
  };
}

// A deposit's tax, split across components: each takes its pro-rata share and
// the largest absorbs any rounding cent, so the parts sum to depositTaxCents.
export function splitTaxes<T extends { amountCents: number }>(taxes: readonly T[], pct: number, depositTaxCents: number): (T & { amountCents: Cents })[] {
  const parts = taxes.map((t) => ({ ...t, amountCents: pctOf(t.amountCents as Cents, pct) }));
  const diff = depositTaxCents - parts.reduce((s, t) => s + t.amountCents, 0);
  if (diff !== 0 && parts.length) {
    const largest = parts.reduce((a, b) => (b.amountCents > a.amountCents ? b : a));
    largest.amountCents = (largest.amountCents + diff) as Cents;
  }
  return parts;
}
