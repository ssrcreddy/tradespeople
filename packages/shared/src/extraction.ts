import { z } from "zod";

// What the LLM may return (design §13). Sent to the model as strict
// structured-output JSON Schema; strict mode drops some refinements, so the
// bounds are re-checked in code after the Zod parse (see checkExtraction).
export const ExtractedLine = z.object({
  description: z.string(),                // normalised, trade vocabulary
  priceBookItemId: z.string().nullable(), // catalogue ID if aligned (§17 stage 1)
  qty: z.number(),                        // decimal from the model; converted to qty_milli
  qtyStated: z.boolean(),                 // false = defaulted to 1, must ask
  unit: z.enum(["each", "hour", "flat", "metre", "foot"]),
  kind: z.enum(["labour", "material", "callout", "fixed_job", "assembly"]),
  sourceKind: z.enum(["text", "photo"]),
  sourceQuote: z.string(),                // verbatim from the text, or what the photo shows
  confidence: z.number(),                 // displayed only — never gates anything
  // NO price field. The model is never asked for money.
});

export const ExtractionResult = z.object({
  isEnquiry: z.boolean(),                 // false = not a job (supplier mail, spam)
  customer: z.object({
    name: z.string().nullable(),
    email: z.string().nullable(),         // read from forwarded headers too (§16)
    phone: z.string().nullable(),
    siteAddress: z.string().nullable(),
  }),
  jobType: z.string(),                    // e.g. "ev_charger_install"
  summary: z.string(),
  urgency: z.enum(["routine", "soon", "urgent", "unknown"]),
  lines: z.array(ExtractedLine),          // may be empty …
  questions: z.array(z.string()),         // … but only if there are questions
});
export type ExtractionResult = z.infer<typeof ExtractionResult>;
export type ExtractedLine = z.infer<typeof ExtractedLine>;

const QTY_CAP: Record<ExtractedLine["unit"], number> = {
  each: 500, hour: 80, flat: 1, metre: 1000, foot: 3000,
};

// Post-parse bounds that strict structured output cannot express.
// Returns human-readable problems; empty array = valid.
export function checkExtraction(r: ExtractionResult): string[] {
  const problems: string[] = [];
  if (r.isEnquiry && r.lines.length === 0 && r.questions.length === 0) {
    problems.push("no lines and no questions");
  }
  r.lines.forEach((l, i) => {
    if (l.description.trim().length < 3) problems.push(`line ${i}: description too short`);
    if (!(l.qty > 0) || l.qty > QTY_CAP[l.unit]) problems.push(`line ${i}: qty ${l.qty} out of range for ${l.unit}`);
    if (l.confidence < 0 || l.confidence > 1) problems.push(`line ${i}: confidence ${l.confidence} not in [0,1]`);
    if (l.sourceQuote.trim().length < 3) problems.push(`line ${i}: sourceQuote too short`);
  });
  if (r.customer.email !== null && !z.email().safeParse(r.customer.email).success) {
    problems.push(`customer email "${r.customer.email}" is not valid`);
  }
  return problems;
}
