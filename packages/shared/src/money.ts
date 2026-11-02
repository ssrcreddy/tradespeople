// The only arithmetic helpers allowed to touch money (design §11, §13).
// Integer cents, integer milli-quantities, rates in parts per million.
export type Cents = number & { __brand: "Cents" };
export type QtyMilli = number & { __brand: "QtyMilli" };   // 1.5 → 1500
export type RatePpm = number & { __brand: "RatePpm" };     // 13% → 130_000

// Half-up division of non-negative BigInts — the only rounding in the system.
export const divHalfUp = (n: bigint, d: bigint): bigint => (n * 2n + d) / (d * 2n);

export const mulQtyRate = (q: QtyMilli, rate: Cents): Cents =>
  Number(divHalfUp(BigInt(q) * BigInt(rate), 1000n)) as Cents;

export const applyRatePpm = (amount: Cents, r: RatePpm): Cents =>
  Number(divHalfUp(BigInt(amount) * BigInt(r), 1_000_000n)) as Cents;

export const sumCents = (xs: readonly Cents[]): Cents => xs.reduce((a, b) => a + b, 0) as Cents;

// Share of an amount by an integer percentage, half-up.
export const pctOf = (amount: Cents, pct: number): Cents =>
  Number(divHalfUp(BigInt(amount) * BigInt(pct), 100n)) as Cents;

// Sell rate from supplier cost + markup (price book materials, §12).
export const applyMarkup = (cost: Cents, markupPpm: RatePpm): Cents =>
  (cost + applyRatePpm(cost, markupPpm)) as Cents;

// Parse a decimal string ("1.5", "12", "0.25") to thousandths without floats.
export function parseQtyMilli(s: string): QtyMilli {
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(s.trim());
  if (!m) throw new Error(`invalid quantity "${s}"`);
  const whole = Number(m[1]);
  const frac = Number((m[2] ?? "").padEnd(3, "0"));
  return (whole * 1000 + frac) as QtyMilli;
}

// 1500 → "1.5", 12000 → "12", 1 → "0.001"
export function formatQtyMilli(q: QtyMilli): string {
  const whole = Math.trunc(q / 1000);
  const frac = String(q % 1000).padStart(3, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

// Model output arrives as a JSON number; round it once at the boundary.
export const toQtyMilli = (qty: number): QtyMilli => Math.round(qty * 1000) as QtyMilli;
