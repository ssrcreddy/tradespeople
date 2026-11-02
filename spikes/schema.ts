// Spike 4a — extraction schema → strict structured-output JSON Schema (design §13, §16).
// Usage: pnpm schema        (offline; no API key needed)
// Proves: the OpenAI SDK helper accepts our Zod 4 schema and produces a schema
// that satisfies strict-mode rules (every object closed, every property required,
// nullability expressed as a union, no exotic keywords).
import { mkdir, writeFile } from "node:fs/promises";
import { zodTextFormat } from "openai/helpers/zod";
import { ExtractionResult } from "@qa/shared";

type Json = Record<string, unknown>;

const format = zodTextFormat(ExtractionResult, "extraction");
const schema = format.schema as Json;
await mkdir("out", { recursive: true });
await writeFile("out/extraction.schema.json", JSON.stringify(schema, null, 2));

// Keywords we expect a plain schema to use. Anything else is printed for review
// (strict mode accepts a limited keyword set; the provider docs are the authority).
const BASIC = new Set([
  "type", "properties", "required", "additionalProperties", "items", "enum",
  "anyOf", "description", "$schema", "$defs", "definitions", "$ref", "title", "const", "default",
]);

const problems: string[] = [];
const extraKeywords = new Set<string>();

function walk(node: unknown, path: string) {
  if (Array.isArray(node)) { node.forEach((n, i) => walk(n, `${path}[${i}]`)); return; }
  if (!node || typeof node !== "object") return;
  const n = node as Json;
  for (const k of Object.keys(n)) if (!BASIC.has(k)) extraKeywords.add(`${k} @ ${path}`);

  const isObject = n.type === "object" || (Array.isArray(n.type) && n.type.includes("object"));
  if (isObject && n.properties) {
    if (n.additionalProperties !== false) problems.push(`${path}: additionalProperties is not false`);
    const props = Object.keys(n.properties as Json);
    const req = new Set((n.required as string[] | undefined) ?? []);
    const missing = props.filter((p) => !req.has(p));
    if (missing.length) problems.push(`${path}: not required → ${missing.join(", ")}`);
  }
  for (const [k, v] of Object.entries(n)) {
    if (k === "properties" && v && typeof v === "object") {
      for (const [pk, pv] of Object.entries(v as Json)) walk(pv, `${path}.${pk}`);
    } else if (typeof v === "object") walk(v, `${path}.${k}`);
  }
}
walk(schema, "$");

// Nullable fields must survive as unions, or the model cannot return null.
const nullable = ["customer.name", "customer.email", "customer.phone", "customer.siteAddress", "lines[].priceBookItemId"];
const text = JSON.stringify(schema);
const nullCount = (text.match(/"null"/g) ?? []).length;

console.log(`SDK format: type=${format.type} name=${format.name} strict=${format.strict}`);
console.log(`schema written to out/extraction.schema.json (${text.length} chars)`);
console.log(`nullable fields expected: ${nullable.length}, "null" types found: ${nullCount}`);
console.log(`strict-rule problems: ${problems.length ? "\n  " + problems.join("\n  ") : "none"}`);
console.log(`non-basic keywords: ${extraKeywords.size ? "\n  " + [...extraKeywords].join("\n  ") : "none"}`);

// Round trip: a hand-written valid result must parse with the same Zod schema.
const sample = {
  isEnquiry: true,
  customer: { name: "Priya Shah", email: "priya@example.com", phone: null, siteAddress: "14 Elm St" },
  jobType: "ev_charger_install", summary: "Level 2 charger in garage", urgency: "soon",
  lines: [{ description: "EV charger install", priceBookItemId: "pb_123", qty: 1, qtyStated: true,
            unit: "each", kind: "assembly", sourceKind: "text", sourceQuote: "install a charger for my new EV", confidence: 0.9 }],
  questions: ["What is the main panel's amperage?"],
};
console.log(`sample parses: ${ExtractionResult.safeParse(sample).success}`);
const priced = { ...sample, lines: [{ ...sample.lines[0], unitPriceCents: 100 }] };
const pricedParsed = ExtractionResult.safeParse(priced);
console.log(`a smuggled price field survives parsing: ${pricedParsed.success && "unitPriceCents" in (pricedParsed.data.lines[0] as object)}`);
process.exit(problems.length ? 1 : 0);
