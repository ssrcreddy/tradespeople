// Extraction prompt assembly and post-parse validation (design §13, §16).
import { readFileSync } from "node:fs";
import { and, asc, eq, inArray } from "drizzle-orm";
import { type ExtractionResult, checkExtraction } from "@qa/shared";
import type { Tx } from "../db/client.ts";
import { assemblyComponents, priceBookItems } from "../db/schema.ts";

export const PROMPT_VERSION = "electrical.extract.v1";
const PROMPT = readFileSync(new URL(`../llm/prompts/${PROMPT_VERSION}.md`, import.meta.url), "utf8");

export interface CatalogueEntry {
  id: string; name: string; kind: string; unit: string; aliases: string[];
  components?: string[];       // assemblies: component names, so the model knows labour is included
}

export async function loadCatalogue(tx: Tx, businessId: string): Promise<CatalogueEntry[]> {
  const items = await tx.select({
    id: priceBookItems.id, name: priceBookItems.name, kind: priceBookItems.kind, unit: priceBookItems.unit, aliases: priceBookItems.aliases,
  }).from(priceBookItems)
    .where(and(eq(priceBookItems.businessId, businessId), eq(priceBookItems.active, true)))
    .orderBy(asc(priceBookItems.name));
  const asmIds = items.filter((i) => i.kind === "assembly").map((i) => i.id);
  const comps = asmIds.length
    ? await tx.select({ assemblyId: assemblyComponents.assemblyId, name: priceBookItems.name })
        .from(assemblyComponents)
        .innerJoin(priceBookItems, eq(priceBookItems.id, assemblyComponents.componentId))
        .where(and(eq(assemblyComponents.businessId, businessId), inArray(assemblyComponents.assemblyId, asmIds)))
        .orderBy(asc(assemblyComponents.sort))
    : [];
  return items.map((i) => (i.kind === "assembly"
    ? { ...i, components: comps.filter((c) => c.assemblyId === i.id).map((c) => c.name) }
    : i));
}

export function renderInstructions(author: "customer" | "tradesperson", catalogue: CatalogueEntry[], problems: string[] = []) {
  let text = PROMPT
    .replace("{{AUTHOR}}", author === "customer" ? "the customer (an enquiry, possibly forwarded by the tradesperson)" : "the tradesperson (their own notes from a site visit)")
    .replace("{{CATALOGUE}}", JSON.stringify(catalogue));
  if (problems.length) {
    text += `\n\nYour previous answer had these problems. Fix them:\n- ${problems.join("\n- ")}`;
  }
  return text;
}

export function renderInput(cleanedText: string, contactHint: { name: string | null; email: string | null } | null, photoCount: number) {
  const hint = contactHint && (contactHint.name || contactHint.email)
    ? `Contact hint from forwarded headers: name=${contactHint.name ?? "unknown"}, email=${contactHint.email ?? "unknown"}\n\n` : "";
  const photos = photoCount ? `\n\n(${photoCount} photo${photoCount > 1 ? "s" : ""} attached.)` : "";
  return `${hint}<message>\n${cleanedText || "(no text)"}\n</message>${photos}`;
}

// ---------- validation ----------

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.split(" ").filter(Boolean)) {
    const p = `  ${w} `;
    for (let i = 0; i < p.length - 2; i++) out.add(p.slice(i, i + 3));
  }
  return out;
}

function similarity(a: string, b: string): number {
  const A = trigrams(a), B = trigrams(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const t of A) if (B.has(t)) both++;
  return both / (A.size + B.size - both);
}

// Models paraphrase slightly; accept an exact normalised hit, else the best
// window of similar length with trigram similarity ≥ 0.85.
export function quoteFound(quote: string, text: string): boolean {
  const q = norm(quote), t = norm(text);
  if (!q) return false;
  if (t.includes(q)) return true;
  const qWords = q.split(" ").length, tWords = t.split(" ");
  for (let len = Math.max(1, qWords - 2); len <= qWords + 2; len++) {
    for (let i = 0; i + len <= tWords.length; i++) {
      if (similarity(q, tWords.slice(i, i + len).join(" ")) >= 0.85) return true;
    }
  }
  return false;
}

const HAS_NUMBER = /\d|\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|half|couple|dozen|pair)\b/i;

export interface Validated { result: ExtractionResult; problems: string[] }

export function validateExtraction(raw: ExtractionResult, cleanedText: string, catalogueIds: Set<string>): Validated {
  const problems = checkExtraction(raw);
  const lines = raw.lines.map((l, i) => {
    if (l.sourceKind === "text" && !quoteFound(l.sourceQuote, cleanedText)) {
      problems.push(`line ${i} ("${l.description}"): sourceQuote is not in the message text — copy it verbatim`);
    }
    // A catalogue id the business doesn't have is nulled, not fatal (§16).
    const priceBookItemId = l.priceBookItemId && catalogueIds.has(l.priceBookItemId) ? l.priceBookItemId : null;
    // A "stated" quantity whose source quote holds no number was not stated.
    const qtyStated = l.qtyStated && (l.sourceKind === "photo" || HAS_NUMBER.test(l.sourceQuote));
    return { ...l, priceBookItemId, qtyStated, qty: qtyStated ? l.qty : 1 };
  });
  return { result: { ...raw, lines }, problems };
}

export { norm as normaliseForMatch, similarity as trigramSimilarity };
