// Price-book matching (design §17): deterministic first, model-assisted only
// through the catalogue ids, human-final always. Never invents a price: an
// unmatched line gets unit_price = null (needs price) plus suggestions.
import { and, eq, sql } from "drizzle-orm";
import { type Cents, type ExtractedLine, toQtyMilli } from "@qa/shared";
import type { Tx } from "../db/client.ts";
import { priceBookItems } from "../db/schema.ts";
import { expandItem } from "./priceBook.ts";
import { normaliseForMatch } from "./extraction.ts";
import type { DraftLine } from "./quotes.ts";

// Tuned on the golden set (§24) — change only with an eval run.
export const THRESHOLDS = { match: 0.6, lead: 0.1, suggest: 0.35, idSanity: 0.3, showCandidate: 0.15 } as const;

interface Scored { id: string; name: string; kind: string; unit: DraftLine["unit"]; rateCents: number | null; aliases: string[]; score: number }

async function score(tx: Tx, businessId: string, query: string): Promise<Scored[]> {
  return tx.select({
    id: priceBookItems.id, name: priceBookItems.name, kind: priceBookItems.kind, unit: priceBookItems.unit,
    rateCents: priceBookItems.rateCents, aliases: priceBookItems.aliases,
    score: sql<number>`price_book_similarity(${priceBookItems.name}, ${priceBookItems.aliases}, ${query})`,
  }).from(priceBookItems)
    .where(and(eq(priceBookItems.businessId, businessId), eq(priceBookItems.active, true)))
    .then((rows) => rows.sort((a, b) => b.score - a.score));
}

// Mirrors price_book_core_name() in SQL: "GFCI receptacle, 15 A" → "GFCI receptacle".
export const coreName = (name: string) => name.split(/\s+[—–-]\s+|\s*[,(]/)[0]!.trim();

export type MatchStage = "catalogue_id" | "alias" | "trigram" | "none";

export interface MatchResult { stage: MatchStage; itemId: string | null; candidates: { id: string; name: string; score: number }[] }

export async function findMatch(tx: Tx, businessId: string, line: ExtractedLine): Promise<MatchResult> {
  const byDescription = await score(tx, businessId, line.description);
  const byQuote = line.sourceKind === "text" ? await score(tx, businessId, line.sourceQuote) : [];
  const best = new Map<string, Scored>();
  for (const s of [...byDescription, ...byQuote]) {
    const prev = best.get(s.id);
    if (!prev || s.score > prev.score) best.set(s.id, s);
  }
  const ranked = [...best.values()].sort((a, b) => b.score - a.score);
  const candidates = ranked.filter((r) => r.score >= THRESHOLDS.showCandidate).slice(0, 3)
    .map((r) => ({ id: r.id, name: r.name, score: Math.round(r.score * 100) / 100 }));

  // Stage 1: the model aligned the line to a catalogue id — verified to be this
  // business's active item, and lexically sane (the model can pick a wrong id).
  if (line.priceBookItemId) {
    const hit = best.get(line.priceBookItemId);
    if (hit && hit.score >= THRESHOLDS.idSanity) return { stage: "catalogue_id", itemId: hit.id, candidates };
  }

  // Stage 2a: exact hit on the name, its core name, or an alias.
  const d = normaliseForMatch(line.description);
  // A core name like "Cable" can be shared by several items: only a unique hit counts.
  const exact = ranked.filter((r) => [r.name, coreName(r.name), ...r.aliases].some((a) => normaliseForMatch(a) === d));
  if (exact.length === 1) return { stage: "alias", itemId: exact[0]!.id, candidates };

  // Stage 2b: trigram similarity with a clear lead over the runner-up.
  const [top, second] = ranked;
  if (top && top.score >= THRESHOLDS.match && top.score - (second?.score ?? 0) >= THRESHOLDS.lead) {
    return { stage: "trigram", itemId: top.id, candidates };
  }
  return { stage: "none", itemId: null, candidates };
}

export async function matchLines(tx: Tx, businessId: string, lines: ExtractedLine[]): Promise<{ lines: DraftLine[]; stages: MatchStage[] }> {
  const out: DraftLine[] = [];
  const stages: MatchStage[] = [];
  for (const line of lines) {
    const m = await findMatch(tx, businessId, line);
    stages.push(m.stage);
    const qtyMilli = toQtyMilli(line.qty);
    const base = {
      optional: false, sourceQuote: line.sourceQuote, extractedSnapshot: line,
      qtyToConfirm: !line.qtyStated, suggestions: null,
    };
    if (m.itemId) {
      const expanded = await expandItem(tx, businessId, m.itemId, qtyMilli);
      for (const e of expanded) {
        out.push({
          ...base, ...e,
          sourceKind: e.sourceKind === "assembly" ? "assembly" : line.sourceKind,
          unitPriceCents: e.unitPriceCents,         // null when the book has no rate yet → needs price
        });
      }
    } else {
      out.push({
        ...base,
        description: line.description, qtyMilli, unit: line.unit,
        unitPriceCents: null as Cents | null,      // never guessed
        priceBookItemId: null, groupKey: null, sourceKind: line.sourceKind,
        suggestions: m.candidates.length ? m.candidates : null,
      });
    }
  }
  return { lines: out, stages };
}
