import { z } from "zod";

const int = () => z.number().int().nonnegative();

export const TaxComponent = z.object({
  name: z.string().min(1).max(20),          // "HST", "GST", "PST", "QST"
  ratePpm: int().max(1_000_000),            // 130_000 = 13%; 99_750 = 9.975%
  regNo: z.string().max(40).nullable(),
});
export type TaxComponent = z.infer<typeof TaxComponent>;
export const TaxComponents = z.array(TaxComponent).max(3);

// Presets shown at onboarding — data, not hardcodes in the engine.
export const TAX_PRESETS = {
  "ON-HST": [{ name: "HST", ratePpm: 130_000, regNo: null }],
  "NS-HST": [{ name: "HST", ratePpm: 140_000, regNo: null }],
  "BC-GST-PST": [{ name: "GST", ratePpm: 50_000, regNo: null }, { name: "PST", ratePpm: 70_000, regNo: null }],
  "QC-GST-QST": [{ name: "GST", ratePpm: 50_000, regNo: null }, { name: "QST", ratePpm: 99_750, regNo: null }],
  "AB-GST": [{ name: "GST", ratePpm: 50_000, regNo: null }],
} satisfies Record<string, TaxComponent[]>;

export const QuoteStatus = z.enum([
  "draft", "approved", "sending", "sent", "accepted", "declined", "expired", "superseded",
]);
export type QuoteStatus = z.infer<typeof QuoteStatus>;

export const LineUnit = z.enum(["each", "hour", "flat", "metre", "foot"]);
export const PriceBookKind = z.enum(["labour", "material", "callout", "fixed_job", "assembly"]);

// Quantities cross the API as decimal strings ("1.5") and are parsed to
// qty_milli without floats (money.ts parseQtyMilli).
export const QtyString = z.string().regex(/^\d+(\.\d{1,3})?$/, "quantity must be a decimal with up to 3 places");

export const QuoteLineInput = z.object({
  id: z.uuid().optional(),                    // existing line: keeps its provenance (source quote, extracted snapshot)
  description: z.string().trim().min(1).max(500),
  qty: QtyString,
  unit: LineUnit,
  unitPriceCents: int().nullable(),           // null = needs price
  priceBookItemId: z.uuid().nullable().default(null),
  optional: z.boolean().default(false),
  groupKey: z.string().max(64).nullable().default(null),
});
export type QuoteLineInput = z.infer<typeof QuoteLineInput>;

export const QuotePatch = z.object({
  lockVersion: z.number().int().nonnegative(),
  lines: z.array(QuoteLineInput).max(200).optional(),
  discountCents: int().optional(),
  terms: z.string().max(4000).optional(),
  depositPct: int().max(100).optional(),
});
export type QuotePatch = z.infer<typeof QuotePatch>;

export const AddFromPriceBook = z.object({
  lockVersion: z.number().int().nonnegative(),
  priceBookItemId: z.uuid(),
  qty: QtyString.default("1"),
});

export const PreviewRequest = z.object({
  lines: z.array(QuoteLineInput).max(200),
  discountCents: int().default(0),
});
