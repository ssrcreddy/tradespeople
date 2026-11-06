import { z } from "zod";
import { TaxComponent } from "./quote.ts";

// Frozen document contents (design §13). PDFs and invoices derive from these,
// never from live rows.
const int = () => z.number().int().nonnegative();

const SnapshotLine = z.object({
  description: z.string(), qtyMilli: int(), unit: z.string(),
  unitPriceCents: int(), lineTotalCents: int(),
  optional: z.boolean(), groupKey: z.string().nullable(),
});
export type SnapshotLine = z.infer<typeof SnapshotLine>;

const SnapshotCustomer = z.object({
  name: z.string(), email: z.string().nullable(), phone: z.string().nullable(), siteAddress: z.string().nullable(),
});

const TaxAmount = TaxComponent.extend({ amountCents: int() });

export const QuoteSnapshot = z.object({
  templateVersion: z.literal(1),
  number: z.string(), version: int(),      // "Q-0042", 2
  currency: z.string().length(3),
  business: z.object({ name: z.string() }),
  customer: SnapshotCustomer,
  lines: z.array(SnapshotLine),
  subtotalCents: int(), discountCents: int(),
  taxes: z.array(TaxAmount),
  taxCents: int(), totalCents: int(),
  optionalTotalCents: int(),               // shown as "optional extras", not in total
  depositPct: int().max(100),
  collapseAssemblies: z.boolean(),
  terms: z.string(), issuedOn: z.string(), expiresOn: z.string(),   // ISO dates, business timezone
});
export type QuoteSnapshot = z.infer<typeof QuoteSnapshot>;

export const InvoiceSnapshot = z.object({
  templateVersion: z.literal(1),
  kind: z.enum(["deposit", "final"]),
  number: z.string(),                      // "INV-0007"
  quoteRef: z.string(),                    // "Q-0042 v2"
  currency: z.string().length(3),
  business: z.object({ name: z.string() }),
  customer: SnapshotCustomer,
  lines: z.array(SnapshotLine),
  subtotalCents: int(), discountCents: int(),
  taxes: z.array(TaxAmount),
  taxCents: int(),
  totalCents: int(),                       // this document's total before any deposit credit
  lessDepositCents: int(),
  lessDepositRef: z.string().nullable(),   // "INV-0006"
  amountDueCents: int(),
  collapseAssemblies: z.boolean(),
  terms: z.string(), issuedOn: z.string(),
});
export type InvoiceSnapshot = z.infer<typeof InvoiceSnapshot>;

export const quoteNumber = (n: number) => `Q-${String(n).padStart(4, "0")}`;
export const invoiceNumber = (n: number) => `INV-${String(n).padStart(4, "0")}`;
