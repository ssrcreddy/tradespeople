import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { type Cents, type QtyMilli, type TaxComponent, parseQtyMilli, applyMarkup, type RatePpm, TAX_PRESETS } from "@qa/shared";
import { computeTotals, previewTotals, splitDeposit, EngineError, type EngineLine } from "../../src/services/quoteEngine.ts";

const line = (qty: string, cents: number | null, optional = false): EngineLine => ({
  qtyMilli: parseQtyMilli(qty), unitPriceCents: cents as Cents | null, optional,
});
const cfg = (discountCents = 0, taxes: TaxComponent[] = TAX_PRESETS["ON-HST"]) => ({ discountCents: discountCents as Cents, taxes });

describe("computeTotals — examples", () => {
  it("fractional hours without float error (1.15 h × $85.00)", () => {
    // 1.15 * 8500 in floats is 9774.999999999998
    expect(computeTotals([line("1.15", 8500)], cfg()).lines[0]!.lineTotalCents).toBe(9775);
  });

  it("rounds half-cents up per line", () => {
    const t = computeTotals([line("0.5", 1), line("1.5", 3), line("0.333", 100)], cfg(0, []));
    expect(t.lines.map((l) => l.lineTotalCents)).toEqual([1, 5, 33]);
    expect(t.subtotalCents).toBe(39);
  });

  it("Ontario HST 13%", () => {
    const t = computeTotals([line("2", 5000)], cfg());
    expect(t).toMatchObject({ subtotalCents: 10000, taxCents: 1300, totalCents: 11300 });
  });

  it("Quebec GST 5% + QST 9.975%, each component rounded separately", () => {
    const t = computeTotals([line("1", 347910)], cfg(0, TAX_PRESETS["QC-GST-QST"]));
    expect(t.taxes.map((x) => [x.name, x.amountCents])).toEqual([["GST", 17396], ["QST", 34704]]);
    expect(t.totalCents).toBe(347910 + 17396 + 34704);
  });

  it("tax applies after discount", () => {
    const t = computeTotals([line("1", 10000)], cfg(2000));
    expect(t).toMatchObject({ subtotalCents: 10000, discountCents: 2000, taxCents: 1040, totalCents: 9040 });
  });

  it("discount equal to subtotal gives a zero total", () => {
    expect(computeTotals([line("1", 10000)], cfg(10000)).totalCents).toBe(0);
  });

  it("rejects a discount larger than the subtotal", () => {
    expect(() => computeTotals([line("1", 10000)], cfg(10001))).toThrow(EngineError);
  });

  it("0% tax (no components)", () => {
    expect(computeTotals([line("3", 333)], cfg(0, [])).totalCents).toBe(999);
  });

  it("optional lines are priced but excluded from the total", () => {
    const t = computeTotals([line("1", 10000), line("1", 2500, true)], cfg());
    expect(t).toMatchObject({ subtotalCents: 10000, optionalTotalCents: 2500, totalCents: 11300 });
    expect(t.lines[1]!.lineTotalCents).toBe(2500);
  });

  it("refuses unpriced lines", () => {
    expect(() => computeTotals([line("1", 100), line("1", null)], cfg())).toThrowError("UNPRICED_LINE");
  });

  it("assembly lines total like any other lines (charger + cable + breaker + 4 h)", () => {
    const t = computeTotals([line("1", 89900), line("30", 450), line("1", 6500), line("4", 9500)], cfg(5000));
    expect(t.subtotalCents).toBe(89900 + 13500 + 6500 + 38000);
    expect(t.totalCents).toBe(t.subtotalCents - 5000 + t.taxCents);
  });
});

describe("previewTotals", () => {
  it("counts unpriced lines as zero and labels itself incomplete", () => {
    const p = previewTotals([line("1", 10000), line("2", null)], cfg());
    expect(p).toMatchObject({ complete: false, unpricedLines: 1, subtotalCents: 10000 });
    expect(p.lines[1]!.unitPriceCents).toBeNull();
  });

  it("flags an over-large discount instead of throwing", () => {
    const p = previewTotals([line("1", 100)], cfg(500));
    expect(p).toMatchObject({ complete: false, discountExceedsSubtotal: true, totalCents: 0 });
  });

  it("is complete and equal to the strict path when everything is priced", () => {
    const lines = [line("1.5", 4999), line("1", 100, true)];
    const p = previewTotals(lines, cfg(50));
    const s = computeTotals(lines, cfg(50));
    expect(p.complete).toBe(true);
    expect(p.totalCents).toBe(s.totalCents);
  });
});

describe("splitDeposit", () => {
  it("30% of a quote; deposit + balance = total exactly", () => {
    const d = splitDeposit({ totalCents: 11301 as Cents, taxCents: 1301 as Cents }, 30);
    expect(d).toEqual({ depositTotalCents: 3390, depositTaxCents: 390, balanceTotalCents: 7911, balanceTaxCents: 911 });
  });
  it("0% and 100%", () => {
    expect(splitDeposit({ totalCents: 999 as Cents, taxCents: 99 as Cents }, 0).balanceTotalCents).toBe(999);
    expect(splitDeposit({ totalCents: 999 as Cents, taxCents: 99 as Cents }, 100).balanceTotalCents).toBe(0);
  });
  it("rejects non-integer or out-of-range percentages", () => {
    expect(() => splitDeposit({ totalCents: 1 as Cents, taxCents: 0 as Cents }, 33.3)).toThrow(RangeError);
    expect(() => splitDeposit({ totalCents: 1 as Cents, taxCents: 0 as Cents }, 101)).toThrow(RangeError);
  });
});

describe("money helpers", () => {
  it("parseQtyMilli parses decimals without floats", () => {
    expect(parseQtyMilli("1.5")).toBe(1500);
    expect(parseQtyMilli("0.001")).toBe(1);
    expect(parseQtyMilli("12")).toBe(12000);
    expect(() => parseQtyMilli("1.2345")).toThrow();
    expect(() => parseQtyMilli("-1")).toThrow();
  });
  it("applyMarkup: $12.34 cost + 35% markup = $16.66 (half-up)", () => {
    expect(applyMarkup(1234 as Cents, 350_000 as RatePpm)).toBe(1666);
  });
});

// ---------- properties ----------

const arbLine = fc.record({
  qtyMilli: fc.integer({ min: 1, max: 500_000 }).map((n) => n as QtyMilli),
  unitPriceCents: fc.integer({ min: 0, max: 5_000_000 }).map((n) => n as Cents),
  optional: fc.boolean(),
});
const arbTaxes = fc.array(
  fc.record({ name: fc.constantFrom("GST", "PST", "QST", "HST"), ratePpm: fc.integer({ min: 0, max: 200_000 }), regNo: fc.constant(null) }),
  { maxLength: 2 },
);
const halfUp = (n: bigint, d: bigint) => (n * 2n + d) / (d * 2n);

describe("computeTotals — properties", () => {
  it("total = Σ counted lines − discount + Σ tax components (the DB check identity)", () => {
    fc.assert(fc.property(fc.array(arbLine, { minLength: 1, maxLength: 40 }), arbTaxes, fc.double({ min: 0, max: 1, noNaN: true }),
      (lines, taxes, discountShare) => {
        const subtotalBefore = computeTotals(lines, cfg(0, taxes)).subtotalCents;
        const discount = Math.floor(subtotalBefore * discountShare);
        const t = computeTotals(lines, cfg(discount, taxes));
        const counted = t.lines.filter((l) => !l.optional).reduce((s, l) => s + l.lineTotalCents, 0);
        expect(t.subtotalCents).toBe(counted);
        expect(t.taxCents).toBe(t.taxes.reduce((s, x) => s + x.amountCents, 0));
        expect(t.totalCents).toBe(t.subtotalCents - t.discountCents + t.taxCents);
        expect(t.discountCents).toBeLessThanOrEqual(t.subtotalCents);
        for (const v of [t.subtotalCents, t.taxCents, t.totalCents, t.optionalTotalCents]) {
          expect(Number.isSafeInteger(v) && v >= 0).toBe(true);
        }
      }), { numRuns: 10_000 });
  });

  it("each line total is the exact product rounded half-up (within half a cent)", () => {
    fc.assert(fc.property(arbLine, (l) => {
      const got = computeTotals([l], cfg(0, [])).lines[0]!.lineTotalCents;
      expect(BigInt(got)).toBe(halfUp(BigInt(l.qtyMilli) * BigInt(l.unitPriceCents), 1000n));
      expect(Math.abs(got - (l.qtyMilli * l.unitPriceCents) / 1000)).toBeLessThanOrEqual(0.5);
    }), { numRuns: 10_000 });
  });

  it("each tax component is the half-up share of the taxable amount", () => {
    fc.assert(fc.property(fc.array(arbLine, { minLength: 1, maxLength: 10 }), arbTaxes, (lines, taxes) => {
      const t = computeTotals(lines, cfg(0, taxes));
      t.taxes.forEach((x) => {
        expect(BigInt(x.amountCents)).toBe(halfUp(BigInt(t.subtotalCents) * BigInt(x.ratePpm), 1_000_000n));
      });
    }), { numRuns: 5_000 });
  });

  it("deposit + balance = total for every percentage", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 10_000_000_00 }), fc.integer({ min: 0, max: 100 }), (total, pct) => {
      const tax = Math.floor(total / 9);
      const d = splitDeposit({ totalCents: total as Cents, taxCents: tax as Cents }, pct);
      expect(d.depositTotalCents + d.balanceTotalCents).toBe(total);
      expect(d.depositTaxCents + d.balanceTaxCents).toBe(tax);
      expect(d.depositTotalCents).toBeGreaterThanOrEqual(0);
      expect(d.balanceTotalCents).toBeGreaterThanOrEqual(0);
    }), { numRuns: 10_000 });
  });

  it("preview equals strict totals whenever every line is priced", () => {
    fc.assert(fc.property(fc.array(arbLine, { minLength: 1, maxLength: 20 }), arbTaxes, (lines, taxes) => {
      const p = previewTotals(lines, cfg(0, taxes));
      expect(p.complete).toBe(true);
      expect(p.totalCents).toBe(computeTotals(lines, cfg(0, taxes)).totalCents);
    }), { numRuns: 2_000 });
  });
});
