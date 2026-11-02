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

// Parse a decimal string ("1.5", "12", "0.25") to thousandths without floats.
export function parseQtyMilli(s: string): QtyMilli {
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(s.trim());
  if (!m) throw new Error(`invalid quantity "${s}"`);
  const whole = Number(m[1]);
  const frac = Number((m[2] ?? "").padEnd(3, "0"));
  return (whole * 1000 + frac) as QtyMilli;
}

// Model output arrives as a JSON number; round it once at the boundary.
export const toQtyMilli = (qty: number): QtyMilli => Math.round(qty * 1000) as QtyMilli;
