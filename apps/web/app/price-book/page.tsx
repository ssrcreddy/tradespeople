"use client";
// The price book (design §22): the rates every quote is priced from.
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, dollarsOf, money, parseDollars } from "@/lib/api";
import { ErrorNote, Shell, btnGhost, btnPrimary, input, useAuthRedirect } from "@/components/Shell";

interface Component { componentId: string; name: string; qty: string; unit: string; rateCents: number | null }
interface Item {
  id: string; kind: string; name: string; unit: string; rateCents: number | null; costCents: number | null; markupPpm: number | null;
  aliases: string[]; active: boolean; components?: Component[]; assemblyPriceCents?: number | null;
}

const KINDS = [["labour", "Labour"], ["callout", "Call-outs"], ["fixed_job", "Fixed jobs"], ["material", "Materials"]] as const;
const UNITS = ["each", "hour", "flat", "metre", "foot"];

export default function PriceBook() {
  const onAuth = useAuthRedirect();
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setItems(await api<Item[]>("/price-book")); }
    catch (e) { if (!onAuth(e)) setError((e as Error).message); }
  }, [onAuth]);
  useEffect(() => { load(); }, [load]);

  const patch = useCallback(async (id: string, body: object) => {
    setError(null);
    try {
      const updated = await api<Item>(`/price-book/${id}`, { method: "PATCH", json: body });
      setItems((xs) => xs?.map((x) => (x.id === id ? updated : x)) ?? xs);
      if (updated.kind !== "assembly") await load();      // assembly prices depend on this rate
    } catch (e) { setError(e instanceof ApiError ? e.message : "Couldn't save"); }
  }, [load]);

  async function remove(i: Item) {
    if (!confirm(`Remove "${i.name}" from the price book? Past quotes keep their prices.`)) return;
    try { await api(`/price-book/${i.id}`, { method: "DELETE" }); await load(); }
    catch (e) { setError(e instanceof ApiError ? e.message : "Couldn't remove it"); }
  }

  const unpriced = items?.filter((i) => i.kind !== "assembly" && i.rateCents === null).length ?? 0;
  return (
    <Shell title="Price book">
      <ErrorNote error={error} />
      {!items && !error && <p className="text-sm text-slate-500">Loading…</p>}
      {unpriced > 0 && <p className="mb-3 rounded bg-amber-50 px-3 py-2 text-sm text-amber-800">{unpriced} item{unpriced > 1 ? "s have" : " has"} no rate yet. Lines using them will ask for a price.</p>}
      {items && (
        <>
          <section className="mb-8">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Assemblies</h2>
            <p className="mb-2 text-xs text-slate-500">Bundles of parts and labour. This is where your labour hours live, so the AI never has to guess them.</p>
            <div className="space-y-2">
              {items.filter((i) => i.kind === "assembly").map((a) => <Assembly key={a.id} item={a} items={items} onPatch={patch} onRemove={remove} />)}
            </div>
          </section>
          {KINDS.map(([kind, label]) => {
            const rows = items.filter((i) => i.kind === kind);
            if (!rows.length) return null;
            return (
              <section key={kind} className="mb-8">
                <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">{label}</h2>
                <ul className="divide-y rounded-lg border bg-white">
                  {rows.map((i) => <Row key={`${i.id}:${i.rateCents}`} item={i} onPatch={patch} onRemove={remove} />)}
                </ul>
              </section>
            );
          })}
          <AddItem items={items} onAdded={load} />
        </>
      )}
    </Shell>
  );
}

function Row({ item, onPatch, onRemove }: { item: Item; onPatch: (id: string, b: object) => void; onRemove: (i: Item) => void }) {
  const [rate, setRate] = useState(dollarsOf(item.rateCents));
  const [aliases, setAliases] = useState(item.aliases.join(", "));
  const save = () => {
    const c = parseDollars(rate);
    if (c !== "invalid" && c !== item.rateCents) onPatch(item.id, { rateCents: c });
  };
  const saveAliases = () => {
    const next = aliases.split(",").map((a) => a.trim()).filter(Boolean);
    if (next.join("|") !== item.aliases.join("|")) onPatch(item.id, { aliases: next });
  };
  return (
    <li className="grid grid-cols-[1fr_auto] gap-2 px-3 py-2 text-sm md:grid-cols-[2fr_2fr_8rem_auto] md:items-center">
      <span className="font-medium">{item.name} <span className="font-normal text-slate-500">/ {item.unit}</span>
        {item.markupPpm !== null && <span className="ml-1 text-xs text-slate-500">({item.markupPpm / 10_000}% on {money(item.costCents)})</span>}
      </span>
      <input aria-label={`Other words for ${item.name}`} className={`${input} order-3 col-span-2 md:order-none md:col-span-1`} placeholder="Words customers use, comma separated" value={aliases} onChange={(e) => setAliases(e.target.value)} onBlur={saveAliases} />
      <input aria-label={`Rate for ${item.name}`} inputMode="decimal" className={`${input} text-right ${parseDollars(rate) === "invalid" ? "border-rose-400" : ""} ${item.rateCents === null ? "border-amber-400" : ""}`} placeholder="Rate" value={rate} onChange={(e) => setRate(e.target.value)} onBlur={save} />
      <button aria-label={`Remove ${item.name}`} className="hidden px-1 text-slate-400 hover:text-rose-600 md:block" onClick={() => onRemove(item)}>✕</button>
    </li>
  );
}

function Assembly({ item, items, onPatch, onRemove }: { item: Item; items: Item[]; onPatch: (id: string, b: object) => void; onRemove: (i: Item) => void }) {
  const comps = item.components ?? [];
  const send = (next: { componentId: string; qty: string }[]) => onPatch(item.id, { components: next });
  const plain = comps.map((c) => ({ componentId: c.componentId, qty: c.qty }));
  return (
    <div className="rounded-lg border bg-white p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{item.name}</span>
        <span className="flex items-center gap-2 tabular-nums">
          {item.assemblyPriceCents == null ? <span className="text-amber-700">needs rates</span> : money(item.assemblyPriceCents)}
          <button aria-label={`Remove ${item.name}`} className="text-slate-400 hover:text-rose-600" onClick={() => onRemove(item)}>✕</button>
        </span>
      </div>
      <ul className="mt-2 space-y-1">
        {comps.map((c, n) => (
          <li key={c.componentId} className="grid grid-cols-[5rem_1fr_auto] items-center gap-2">
            <input aria-label={`Quantity of ${c.name}`} inputMode="decimal" className={`${input} text-right`} defaultValue={c.qty}
              onBlur={(e) => { if (/^\d+(\.\d{1,3})?$/.test(e.target.value) && Number(e.target.value) > 0 && e.target.value !== c.qty) send(plain.map((p, i) => (i === n ? { ...p, qty: e.target.value } : p))); }} />
            <span>{c.unit} · {c.name}{c.rateCents === null && <span className="ml-1 text-amber-700">(no rate)</span>}</span>
            <button aria-label={`Take ${c.name} out`} className="text-slate-400 hover:text-rose-600" disabled={comps.length === 1} onClick={() => send(plain.filter((_, i) => i !== n))}>✕</button>
          </li>
        ))}
      </ul>
      <select aria-label="Add a part" className={`${input} mt-2`} value="" onChange={(e) => { if (e.target.value) send([...plain, { componentId: e.target.value, qty: "1" }]); }}>
        <option value="">Add a part or labour…</option>
        {items.filter((i) => i.kind !== "assembly" && !comps.some((c) => c.componentId === i.id)).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
      </select>
    </div>
  );
}

function AddItem({ items, onAdded }: { items: Item[]; onAdded: () => void }) {
  const blank = { kind: "material", name: "", unit: "each", rate: "", cost: "", markup: "" };
  const [f, setF] = useState(blank);
  const [error, setError] = useState<string | null>(null);
  const useMarkup = f.kind === "material" && f.cost.trim() !== "";
  const assembly = f.kind === "assembly";

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const rate = parseDollars(f.rate);
    const cost = parseDollars(f.cost);
    if (rate === "invalid" || cost === "invalid") { setError("Check the amounts"); return; }
    const first = items.find((i) => i.kind !== "assembly");
    const body = assembly
      ? { kind: "assembly", name: f.name, unit: f.unit, components: first ? [{ componentId: first.id, qty: "1" }] : [] }
      : { kind: f.kind, name: f.name, unit: f.unit, ...(useMarkup ? { costCents: cost, markupPpm: Math.round(Number(f.markup || 0) * 10_000) } : { rateCents: rate }) };
    try { await api("/price-book", { method: "POST", json: body }); setF(blank); onAdded(); }
    catch (err) { setError(err instanceof ApiError ? err.message : "Couldn't add it"); }
  }

  return (
    <form onSubmit={add} className="max-w-xl space-y-2 rounded-lg border bg-white p-4 text-sm">
      <h2 className="font-semibold">Add an item</h2>
      <div className="grid grid-cols-2 gap-2">
        <select aria-label="Kind" className={input} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
          {[...KINDS, ["assembly", "Assembly"] as const].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select aria-label="Unit" className={input} value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })}>{UNITS.map((u) => <option key={u}>{u}</option>)}</select>
      </div>
      <input aria-label="Name" required className={input} placeholder="Name, as it should print on the quote" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      {!assembly && (
        <div className="grid grid-cols-3 gap-2">
          <input aria-label="Sell rate" inputMode="decimal" className={input} placeholder="Sell rate" disabled={useMarkup} value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} />
          {f.kind === "material" && <input aria-label="Cost" inputMode="decimal" className={input} placeholder="or cost" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} />}
          {f.kind === "material" && <input aria-label="Markup percent" inputMode="decimal" className={input} placeholder="markup %" value={f.markup} onChange={(e) => setF({ ...f, markup: e.target.value })} />}
        </div>
      )}
      {assembly && <p className="text-xs text-slate-500">It starts with one part; add the rest above once it's created.</p>}
      <ErrorNote error={error} />
      <button className={btnPrimary} disabled={!f.name.trim()}>Add</button>
      <button type="button" className={`${btnGhost} ml-2`} onClick={() => setF(blank)}>Clear</button>
    </form>
  );
}
