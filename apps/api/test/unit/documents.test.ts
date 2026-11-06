import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { Cents, InvoiceSnapshot, QuoteSnapshot } from "@qa/shared";
import { addDays, localHourToInstant, todayIn } from "../../src/services/dates.ts";
import { splitDeposit, splitTaxes } from "../../src/services/quoteEngine.ts";
import { renderInvoicePdf, renderQuotePdf, sha256 } from "../../src/services/pdf.ts";

describe("business-local dates", () => {
  it("today depends on the business's timezone, not the server's", () => {
    const lateUtc = new Date("2026-11-02T03:30:00Z");
    expect(todayIn("America/Toronto", lateUtc)).toBe("2026-11-01");
    expect(todayIn("Asia/Tokyo", lateUtc)).toBe("2026-11-02");
  });
  it("adds days across months and leap years", () => {
    expect(addDays("2026-12-25", 14)).toBe("2027-01-08");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });
  it("09:00 local is the right instant on both sides of daylight saving", () => {
    expect(localHourToInstant("2026-07-15", 9, "America/Toronto").toISOString()).toBe("2026-07-15T13:00:00.000Z");
    expect(localHourToInstant("2026-12-15", 9, "America/Toronto").toISOString()).toBe("2026-12-15T14:00:00.000Z");
    expect(localHourToInstant("2026-11-01", 9, "America/Toronto").toISOString()).toBe("2026-11-01T14:00:00.000Z"); // change day
    expect(localHourToInstant("2026-03-08", 9, "America/Vancouver").toISOString()).toBe("2026-03-08T16:00:00.000Z");
  });
});

describe("deposit tax split", () => {
  it("components always sum to the deposit tax", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 5_000_000 }), fc.integer({ min: 0, max: 5_000_000 }), fc.integer({ min: 0, max: 100 }), (a, b, pct) => {
      const taxes = [{ name: "GST", amountCents: a }, { name: "QST", amountCents: b }];
      const d = splitDeposit({ totalCents: (a + b) as Cents, taxCents: (a + b) as Cents }, pct);
      const parts = splitTaxes(taxes, pct, d.depositTaxCents);
      expect(parts.reduce((s, t) => s + t.amountCents, 0)).toBe(d.depositTaxCents);
      expect(parts.every((t) => t.amountCents >= 0)).toBe(true);
    }), { numRuns: 5_000 });
  });
});

const quote: QuoteSnapshot = {
  templateVersion: 1, number: "Q-0042", version: 2, currency: "CAD", business: { name: "Hélène Côté Électrique" },
  customer: { name: "François Lévesque", email: "f@example.com", phone: null, siteAddress: "12 rue Saint-Jérôme" },
  lines: [
    { description: "Breaker", qtyMilli: 1000, unit: "each", unitPriceCents: 6500, lineTotalCents: 6500, optional: false, groupKey: "ab:EV install" },
    { description: "Labour", qtyMilli: 4000, unit: "hour", unitPriceCents: 9500, lineTotalCents: 38000, optional: false, groupKey: "ab:EV install" },
    { description: "Surge protector", qtyMilli: 1000, unit: "each", unitPriceCents: 24900, lineTotalCents: 24900, optional: true, groupKey: null },
  ],
  subtotalCents: 44500, discountCents: 0, taxes: [{ name: "HST", ratePpm: 130000, regNo: "123456789 RT0001", amountCents: 5785 }],
  taxCents: 5785, totalCents: 50285, optionalTotalCents: 24900, depositPct: 30, collapseAssemblies: true,
  terms: "Valid 30 days.", issuedOn: "2026-11-01", expiresOn: "2026-12-01",
};

describe("PDF rendering", () => {
  it("produces a PDF with fixed dates", async () => {
    const a = await renderQuotePdf(quote);
    expect(a.subarray(0, 5).toString()).toBe("%PDF-");
    expect(a.toString("latin1")).toContain("D:20261101");
    expect(sha256(a)).toHaveLength(64);
  });
  it("handles a long table across pages", async () => {
    const lines = Array.from({ length: 120 }, (_, i) => ({ ...quote.lines[0]!, description: `Line ${i}`, groupKey: null }));
    const pdf = await renderQuotePdf({ ...quote, lines });
    expect((pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length).toBeGreaterThan(1);
  });
  it("renders an invoice with a deposit credit", async () => {
    const inv: InvoiceSnapshot = {
      templateVersion: 1, kind: "final", number: "INV-0002", quoteRef: "Q-0042 v2", currency: "CAD", business: quote.business, customer: quote.customer,
      lines: quote.lines.slice(0, 2), subtotalCents: 44500, discountCents: 0, taxes: quote.taxes, taxCents: 5785, totalCents: 50285,
      lessDepositCents: 15086, lessDepositRef: "INV-0001", amountDueCents: 35199, collapseAssemblies: false, terms: "", issuedOn: "2026-11-01",
    };
    expect((await renderInvoicePdf(inv, "2026-11-15")).subarray(0, 5).toString()).toBe("%PDF-");
  });
});
