// The price book (design §12, §17): items, materials with cost + markup, and
// assemblies — named bundles whose price is always the sum of their parts.
import { readFile } from "node:fs/promises";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  type Cents, type QtyMilli, type RatePpm,
  LineUnit, PriceBookKind, QtyString, applyMarkup, divHalfUp, formatQtyMilli, mulQtyRate, parseQtyMilli, sumCents,
} from "@qa/shared";
import { type Db, type Tx, withTenant } from "../db/client.ts";
import { assemblyComponents, priceBookItems } from "../db/schema.ts";
import { audit } from "./audit.ts";
import { AppError, notFound } from "../http/errors.ts";
import type { TenantCtx } from "../http/context.ts";

const cents = () => z.number().int().nonnegative();

const ComponentInput = z.object({ componentId: z.uuid(), qty: QtyString });

export const ItemInput = z.object({
  kind: PriceBookKind,
  name: z.string().trim().min(1).max(200),
  description: z.string().max(1000).nullable().default(null),
  unit: LineUnit,
  rateCents: cents().nullable().default(null),
  costCents: cents().nullable().default(null),
  markupPpm: z.number().int().min(0).max(10_000_000).nullable().default(null),
  aliases: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  components: z.array(ComponentInput).max(30).optional(),
});
export const ItemPatch = ItemInput.partial().omit({ kind: true });
type ItemInput = z.infer<typeof ItemInput>;

type Item = typeof priceBookItems.$inferSelect;

// Explicit tenant filter on every query (§11) — RLS is the second layer, not the only one.
const inBiz = (businessId: string) => eq(priceBookItems.businessId, businessId);

// Sell rate: explicit rate, or cost + markup when both are given.
function resolveRate(i: Pick<ItemInput, "kind" | "rateCents" | "costCents" | "markupPpm">): number | null {
  if (i.kind === "assembly") return null;
  if (i.costCents != null && i.markupPpm != null) return applyMarkup(i.costCents as Cents, i.markupPpm as RatePpm);
  return i.rateCents;
}

async function writeComponents(tx: Tx, businessId: string, assemblyId: string, comps: z.infer<typeof ComponentInput>[]) {
  if (comps.length === 0) throw new AppError(422, "ASSEMBLY_EMPTY", "an assembly needs at least one component");
  const ids = comps.map((c) => c.componentId);
  if (new Set(ids).size !== ids.length) throw new AppError(422, "DUPLICATE_COMPONENT", "each component may appear once");
  const found = await tx.select({ id: priceBookItems.id, kind: priceBookItems.kind })
    .from(priceBookItems).where(and(inBiz(businessId), inArray(priceBookItems.id, ids)));
  if (found.length !== ids.length) throw new AppError(422, "UNKNOWN_COMPONENT", "a component is not in this price book");
  if (found.some((f) => f.kind === "assembly")) throw new AppError(422, "NESTED_ASSEMBLY", "assemblies cannot contain assemblies");
  await tx.delete(assemblyComponents)
    .where(and(eq(assemblyComponents.businessId, businessId), eq(assemblyComponents.assemblyId, assemblyId)));
  await tx.insert(assemblyComponents).values(comps.map((c, sort) => ({
    businessId, assemblyId, componentId: c.componentId, qtyMilli: parseQtyMilli(c.qty), sort,
  })));
}

export async function createItem(db: Db, t: TenantCtx, input: ItemInput) {
  if (input.kind === "assembly" && !input.components) throw new AppError(422, "ASSEMBLY_EMPTY", "an assembly needs components");
  if (input.kind !== "assembly" && input.components) throw new AppError(422, "NOT_ASSEMBLY", "only assemblies have components");
  return withTenant(db, t.businessId, async (tx) => {
    const { components, ...fields } = input;
    const [item] = await tx.insert(priceBookItems)
      .values({ ...fields, businessId: t.businessId, rateCents: resolveRate(input) }).returning();
    if (components) await writeComponents(tx, t.businessId, item!.id, components);
    await audit(tx, t.businessId, t.userId, "price_book_item", item!.id, "price_book.created", input);
    return (await loadItems(tx, t.businessId, [item!.id]))[0]!;
  });
}

export async function updateItem(db: Db, t: TenantCtx, id: string, patch: z.infer<typeof ItemPatch>) {
  return withTenant(db, t.businessId, async (tx) => {
    const [cur] = await tx.select().from(priceBookItems).where(and(inBiz(t.businessId), eq(priceBookItems.id, id))).for("update");
    if (!cur) throw notFound("price book item");
    const { components, ...fields } = patch;
    if (components && cur.kind !== "assembly") throw new AppError(422, "NOT_ASSEMBLY", "only assemblies have components");
    const merged = { ...cur, ...fields };
    await tx.update(priceBookItems)
      .set({ ...fields, rateCents: resolveRate(merged), updatedAt: new Date() })
      .where(and(inBiz(t.businessId), eq(priceBookItems.id, id)));
    if (components) await writeComponents(tx, t.businessId, id, components);
    await audit(tx, t.businessId, t.userId, "price_book_item", id, "price_book.updated", patch);
    return (await loadItems(tx, t.businessId, [id]))[0]!;
  });
}

// Delete = deactivate: historical quote lines keep their own snapshots.
export async function deactivateItem(db: Db, t: TenantCtx, id: string) {
  return withTenant(db, t.businessId, async (tx) => {
    const r = await tx.update(priceBookItems).set({ active: false, updatedAt: new Date() })
      .where(and(inBiz(t.businessId), eq(priceBookItems.id, id))).returning({ id: priceBookItems.id });
    if (!r.length) throw notFound("price book item");
    await audit(tx, t.businessId, t.userId, "price_book_item", id, "price_book.deactivated");
  });
}

export interface ItemView extends Omit<Item, "businessId"> {
  components?: { componentId: string; name: string; qty: string; unit: string; rateCents: number | null }[];
  assemblyPriceCents?: number | null;    // null while any component has no rate
}

async function loadItems(tx: Tx, businessId: string, ids?: string[]): Promise<ItemView[]> {
  const rows = await tx.select().from(priceBookItems)
    .where(and(inBiz(businessId), ids ? inArray(priceBookItems.id, ids) : undefined))
    .orderBy(asc(priceBookItems.kind), asc(priceBookItems.name));
  const asmIds = rows.filter((r) => r.kind === "assembly").map((r) => r.id);
  const comps = asmIds.length
    ? await tx.select({
        assemblyId: assemblyComponents.assemblyId, componentId: assemblyComponents.componentId,
        qtyMilli: assemblyComponents.qtyMilli, sort: assemblyComponents.sort,
        name: priceBookItems.name, unit: priceBookItems.unit, rateCents: priceBookItems.rateCents,
      }).from(assemblyComponents)
        .innerJoin(priceBookItems, eq(priceBookItems.id, assemblyComponents.componentId))
        .where(and(eq(assemblyComponents.businessId, businessId), inArray(assemblyComponents.assemblyId, asmIds)))
        .orderBy(asc(assemblyComponents.sort))
    : [];
  return rows.map(({ businessId: _b, ...r }) => {
    if (r.kind !== "assembly") return r;
    const mine = comps.filter((c) => c.assemblyId === r.id);
    const priced = mine.every((c) => c.rateCents !== null);
    return {
      ...r,
      components: mine.map((c) => ({ componentId: c.componentId, name: c.name, qty: formatQtyMilli(c.qtyMilli as QtyMilli), unit: c.unit, rateCents: c.rateCents })),
      assemblyPriceCents: priced ? sumCents(mine.map((c) => mulQtyRate(c.qtyMilli as QtyMilli, c.rateCents as Cents))) : null,
    };
  });
}

export async function listItems(db: Db, t: TenantCtx, opts: { includeInactive?: boolean } = {}) {
  return withTenant(db, t.businessId, async (tx) => {
    const all = await loadItems(tx, t.businessId);
    return opts.includeInactive ? all : all.filter((i) => i.active);
  });
}

// Quote lines produced from a price-book item (design §17): an assembly expands
// into one line per component under a shared group key; any other item is one line.
export interface ExpandedLine {
  description: string; qtyMilli: QtyMilli; unit: Item["unit"]; unitPriceCents: Cents | null;
  priceBookItemId: string; groupKey: string | null; sourceKind: "manual" | "assembly";
}

export async function expandItem(tx: Tx, businessId: string, itemId: string, qtyMilli: QtyMilli): Promise<ExpandedLine[]> {
  const [item] = await tx.select().from(priceBookItems)
    .where(and(inBiz(businessId), eq(priceBookItems.id, itemId), eq(priceBookItems.active, true)));
  if (!item) throw notFound("price book item");
  if (item.kind !== "assembly") {
    return [{ description: item.name, qtyMilli, unit: item.unit, unitPriceCents: item.rateCents as Cents | null,
              priceBookItemId: item.id, groupKey: null, sourceKind: "manual" }];
  }
  const comps = await tx.select({
    componentId: assemblyComponents.componentId, qtyMilli: assemblyComponents.qtyMilli,
    name: priceBookItems.name, unit: priceBookItems.unit, rateCents: priceBookItems.rateCents,
  }).from(assemblyComponents)
    .innerJoin(priceBookItems, eq(priceBookItems.id, assemblyComponents.componentId))
    .where(and(eq(assemblyComponents.businessId, businessId), eq(assemblyComponents.assemblyId, item.id)))
    .orderBy(asc(assemblyComponents.sort));
  // The name after the colon prints on customer documents: never truncated.
  const groupKey = `${item.id.slice(0, 8)}:${item.name}`;
  return comps.map((c) => ({
    description: c.name,
    // line qty × component qty, both in thousandths
    qtyMilli: Number(divHalfUp(BigInt(qtyMilli) * BigInt(c.qtyMilli), 1000n)) as QtyMilli,
    unit: c.unit, unitPriceCents: c.rateCents as Cents | null,
    priceBookItemId: c.componentId, groupKey, sourceKind: "assembly" as const,
  }));
}

// ---------- trade starter template ----------

const Starter = z.object({
  items: z.array(z.object({ key: z.string(), kind: PriceBookKind, name: z.string(), unit: LineUnit, aliases: z.array(z.string()) })),
  assemblies: z.array(z.object({
    name: z.string(), unit: LineUnit, aliases: z.array(z.string()),
    components: z.array(z.object({ key: z.string(), qty: QtyString })),
  })),
});

const STARTER_PATH = new URL("../../../../data/trade-packs/electrical/starter.json", import.meta.url);

export async function loadStarter(db: Db, t: TenantCtx) {
  const pack = Starter.parse(JSON.parse(await readFile(STARTER_PATH, "utf8")));
  return withTenant(db, t.businessId, async (tx) => {
    const [{ n }] = (await tx.select({ n: sql<number>`count(*)::int` }).from(priceBookItems).where(inBiz(t.businessId))) as [{ n: number }];
    if (n > 0) throw new AppError(409, "PRICE_BOOK_NOT_EMPTY", "the starter template can only be loaded into an empty price book");
    const inserted = await tx.insert(priceBookItems).values(pack.items.map((i) => ({
      businessId: t.businessId, kind: i.kind, name: i.name, unit: i.unit, aliases: i.aliases, rateCents: null,
    }))).returning({ id: priceBookItems.id, name: priceBookItems.name });
    const idByKey = new Map(pack.items.map((i, k) => [i.key, inserted[k]!.id]));
    for (const a of pack.assemblies) {
      const [asm] = await tx.insert(priceBookItems).values({
        businessId: t.businessId, kind: "assembly", name: a.name, unit: a.unit, aliases: a.aliases,
      }).returning({ id: priceBookItems.id });
      await writeComponents(tx, t.businessId, asm!.id, a.components.map((c) => {
        const componentId = idByKey.get(c.key);
        if (!componentId) throw new Error(`starter pack: unknown component key ${c.key}`);
        return { componentId, qty: c.qty };
      }));
    }
    await audit(tx, t.businessId, t.userId, "price_book", t.businessId, "price_book.starter_loaded",
      { items: pack.items.length, assemblies: pack.assemblies.length });
    return { items: pack.items.length, assemblies: pack.assemblies.length };
  });
}
