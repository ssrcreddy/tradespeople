"use client";
// The core screen (design §22): the original message beside the editable
// draft. Totals always come from the server engine (preview-totals), never
// from arithmetic in the browser.
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, dollarsOf, money, parseDollars } from "@/lib/api";
import { highlight } from "@/lib/highlight";
import { ErrorNote, Shell, btn, btnGhost, btnPrimary, input, useAuthRedirect } from "@/components/Shell";
import { Original, type Job } from "@/components/JobBits";
import { QuoteActions, type QuoteForActions } from "@/components/QuoteActions";
import { CustomerPicker } from "@/components/CustomerPicker";

type Unit = "each" | "hour" | "flat" | "metre" | "foot";
interface Line {
  key: string; id?: string; description: string; qty: string; unit: Unit; price: string;
  priceBookItemId: string | null; optional: boolean; groupKey: string | null;
  qtyToConfirm: boolean; suggestions: { id: string; name: string; score: number }[] | null;
  sourceQuote: string | null; sourceKind: string; originalQty: string;
}
interface Quote extends QuoteForActions {
  number: number; jobId: string | null; customerId: string | null;
  requestedDiscountCents: number; terms: string; lines: any[];
}
interface Totals {
  complete: boolean; unpricedLines: number; discountExceedsSubtotal: boolean; lineTotalsCents: (number | null)[];
  subtotalCents: number; discountCents: number; taxes: { name: string; amountCents: number }[]; taxCents: number; totalCents: number; optionalTotalCents: number;
}
interface BookItem { id: string; name: string; unit: Unit; rateCents: number | null; kind: string; active: boolean }

let seq = 0;
const toLine = (l: any): Line => ({
  key: l.id ?? `new-${++seq}`, id: l.id, description: l.description, qty: l.qty, unit: l.unit, price: dollarsOf(l.unitPriceCents),
  priceBookItemId: l.priceBookItemId, optional: l.optional, groupKey: l.groupKey, qtyToConfirm: l.qtyToConfirm,
  suggestions: l.suggestions, sourceQuote: l.sourceQuote, sourceKind: l.sourceKind, originalQty: l.qty,
});

const QTY = /^\d+(\.\d{1,3})?$/;

export default function Review() {
  const { id } = useParams<{ id: string }>();
  const onAuth = useAuthRedirect();
  const [quote, setQuote] = useState<Quote | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [discount, setDiscount] = useState("");
  const [deposit, setDeposit] = useState("0");
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [book, setBook] = useState<BookItem[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [tab, setTab] = useState<"message" | "quote">("quote");

  const load = useCallback(async () => {
    try {
      const q = await api<Quote>(`/quotes/${id}`);
      setQuote(q);
      setLines(q.lines.map(toLine));
      setDiscount(q.requestedDiscountCents ? dollarsOf(q.requestedDiscountCents) : "");
      setDeposit(String(q.depositPct));
      setCustomerId(q.customerId);
      setDirty(false);
      if (q.jobId) setJob(await api<Job>(`/jobs/${q.jobId}`));
    } catch (e) { if (!onAuth(e)) setError((e as Error).message); }
  }, [id, onAuth]);
  useEffect(() => { load(); api<BookItem[]>("/price-book").then(setBook).catch(() => {}); }, [load]);

  // Validation the server would reject anyway, shown inline before it is sent.
  const invalid = useMemo(() => lines.map((l) => ({
    qty: !QTY.test(l.qty) || Number(l.qty) <= 0, price: parseDollars(l.price) === "invalid", desc: !l.description.trim(),
  })), [lines]);
  const discountCents = parseDollars(discount);
  const depositValid = /^\d{1,3}$/.test(deposit) && Number(deposit) <= 100;
  const anyInvalid = invalid.some((v) => v.qty || v.price || v.desc) || discountCents === "invalid" || !depositValid;
  // Only drafts and approved quotes can change; everything after that is a record.
  const locked = !!quote && quote.status !== "draft" && quote.status !== "approved";

  const payloadLines = useCallback(() => lines.map((l) => ({
    ...(l.id ? { id: l.id } : {}), description: l.description.trim(), qty: l.qty, unit: l.unit,
    unitPriceCents: parseDollars(l.price) as number | null, priceBookItemId: l.priceBookItemId, optional: l.optional, groupKey: l.groupKey,
  })), [lines]);

  // Live totals from the same engine the server stores with (debounced).
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!quote || anyInvalid) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try { setTotals(await api<Totals>(`/quotes/${id}/preview-totals`, { method: "POST", json: { lines: payloadLines(), discountCents: discountCents ?? 0 } })); }
      catch { /* keep the last totals */ }
    }, 250);
  }, [lines, discount, quote, anyInvalid, id, payloadLines, discountCents]);

  const update = (key: string, patch: Partial<Line>) => { setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l))); setDirty(true); };
  const remove = (key: string) => { setLines((ls) => ls.filter((l) => l.key !== key)); setDirty(true); };
  const removeGroup = (g: string) => { setLines((ls) => ls.filter((l) => l.groupKey !== g)); setDirty(true); };
  const addLine = () => { setLines((ls) => [...ls, toLine({ description: "", qty: "1", unit: "each", unitPriceCents: null, priceBookItemId: null, optional: false, groupKey: null, qtyToConfirm: false, suggestions: null, sourceQuote: null, sourceKind: "manual" })]); setDirty(true); };
  // Pricing an unmatched line teaches the book: the customer's words become an alias (§17).
  const addToBook = async (l: Line) => {
    const rateCents = parseDollars(l.price);
    if (typeof rateCents !== "number") return;
    setError(null);
    try {
      const alias = l.sourceQuote && l.sourceQuote.length <= 80 ? [l.sourceQuote] : [];
      const item = await api<BookItem>("/price-book", { method: "POST", json: { kind: "material", name: l.description.trim(), unit: l.unit, rateCents, aliases: alias } });
      setBook((b) => [...b, item]);
      update(l.key, { priceBookItemId: item.id, suggestions: null });
    } catch (e) { setError(e instanceof ApiError ? e.message : "Couldn't add it to the price book"); }
  };
  const pick = (key: string, itemId: string) => {
    const it = book.find((b) => b.id === itemId);
    if (it) update(key, { priceBookItemId: it.id, description: it.name, unit: it.unit, price: dollarsOf(it.rateCents), suggestions: null });
  };

  async function save() {
    if (!quote) return;
    setSaving(true); setError(null);
    try {
      const q = await api<Quote>(`/quotes/${id}`, {
        method: "PATCH",
        json: { lockVersion: quote.lockVersion, lines: payloadLines(), discountCents: discountCents ?? 0, depositPct: Number(deposit), customerId },
      });
      setQuote(q); setLines(q.lines.map(toLine)); setDirty(false);
    } catch (e) {
      if (e instanceof ApiError && e.code === "STALE_QUOTE") setError("This quote changed in another tab. Reload to see the latest version — your edits here are not saved.");
      else setError(e instanceof ApiError ? e.message : "Save failed");
    } finally { setSaving(false); }
  }

  const sentences = useMemo(() => (job ? highlight(job.originalText, lines.map((l) => ({ key: l.key, quote: l.sourceKind === "text" || l.sourceKind === "assembly" ? l.sourceQuote : null }))) : []), [job, lines]);
  const unusedCount = sentences.filter((s) => !s.used).length;

  if (!quote) return <Shell><ErrorNote error={error} />{!error && <p className="text-sm text-slate-500">Loading…</p>}</Shell>;

  const groups = new Map<string, Line[]>();
  for (const l of lines) if (l.groupKey) groups.set(l.groupKey, [...(groups.get(l.groupKey) ?? []), l]);

  return (
    <Shell>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Quote Q-{String(quote.number).padStart(4, "0")} <span className="text-slate-400">v{quote.version}</span>
          <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 align-middle text-xs font-medium">{quote.status}</span></h1>
        <div className="flex gap-2">
          <button className={btnGhost} onClick={load} disabled={saving}>Reload</button>
          {!locked && <button className={btnPrimary} onClick={save} disabled={!dirty || saving || anyInvalid}>{saving ? "Saving…" : "Save draft"}</button>}
        </div>
      </div>
      <ErrorNote error={error} />

      <div className="mb-3 flex gap-1 md:hidden">
        {(["message", "quote"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`${btn} flex-1 ${tab === t ? "bg-slate-800 text-white" : "bg-white border"}`}>{t === "message" ? "Message" : "Quote"}</button>
        ))}
      </div>

      <div className="grid gap-6 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <section className={`${tab === "message" ? "" : "hidden"} md:block`}>
          {job ? (
            <>
              <p className="mb-2 text-xs text-slate-500">
                Highlighted text produced a line. {unusedCount > 0 && <span className="unused not-italic">{unusedCount} sentence{unusedCount > 1 ? "s" : ""} not used by any line — check for anything missed.</span>}
              </p>
              <Original job={job}>
                {sentences.map((s, i) => (
                  <span key={i} className={s.used ? "" : "unused"} title={s.used ? undefined : "Not used by any line"}>
                    {s.pieces.map((p, j) => p.keys.length
                      ? <mark key={j} className={`src ${p.keys.includes(active ?? "") ? "active" : ""}`} onClick={() => { setActive(p.keys[0]!); setTab("quote"); document.getElementById(`line-${p.keys[0]}`)?.scrollIntoView({ block: "center", behavior: "smooth" }); }}>{p.text}</mark>
                      : <span key={j}>{p.text}</span>)}
                  </span>
                ))}
              </Original>
              {job.questions.length > 0 && (
                <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
                  <p className="mb-1 font-medium">Questions to ask the customer</p>
                  <ul className="list-disc pl-5">{job.questions.map((q) => <li key={q}>{q}</li>)}</ul>
                </div>
              )}
            </>
          ) : <p className="text-sm text-slate-500">This quote was started by hand — there is no original message.</p>}
        </section>

        <section className={`${tab === "quote" ? "" : "hidden"} md:block`}>
          <CustomerPicker value={customerId} locked={locked} onPick={(c) => { setCustomerId(c); setDirty(true); }} />
          <fieldset disabled={locked} className="min-w-0">
          <ul className="space-y-2">
            {lines.map((l, i) => {
              const firstOfGroup = l.groupKey && groups.get(l.groupKey)![0]!.key === l.key;
              const v = invalid[i]!;
              return (
                <li key={l.key}>
                  {firstOfGroup && (
                    <div className="mt-3 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-500">
                      <span>Assembly · {l.groupKey!.split(":").slice(1).join(":")}</span>
                      <button className="font-normal normal-case text-rose-600" onClick={() => removeGroup(l.groupKey!)}>Remove assembly</button>
                    </div>
                  )}
                  <div id={`line-${l.key}`} onMouseEnter={() => setActive(l.key)}
                    className={`rounded-lg border bg-white p-3 ${active === l.key ? "ring-2 ring-amber-300" : ""} ${parseDollars(l.price) === null ? "border-rose-300" : ""} ${l.groupKey ? "ml-3" : ""}`}>
                    <div className="flex gap-2">
                      <input aria-label="Description" className={`${input} ${v.desc ? "border-rose-400" : ""}`} value={l.description} onChange={(e) => update(l.key, { description: e.target.value, priceBookItemId: null })} placeholder="Description" />
                      <button aria-label="Remove line" className="px-2 text-slate-400 hover:text-rose-600" onClick={() => remove(l.key)}>✕</button>
                    </div>
                    <div className="mt-2 grid grid-cols-[1fr_1fr_1.3fr_1.2fr] items-center gap-2 text-sm">
                      <input aria-label="Quantity" inputMode="decimal" className={`${input} ${v.qty ? "border-rose-400" : ""}`} value={l.qty} onChange={(e) => update(l.key, { qty: e.target.value })} />
                      <select aria-label="Unit" className={input} value={l.unit} onChange={(e) => update(l.key, { unit: e.target.value as Unit })}>
                        {["each", "hour", "flat", "metre", "foot"].map((u) => <option key={u}>{u}</option>)}
                      </select>
                      <input aria-label="Unit price" inputMode="decimal" placeholder="needs price" className={`${input} ${v.price ? "border-rose-400" : ""}`} value={l.price} onChange={(e) => update(l.key, { price: e.target.value })} />
                      <span className="text-right font-medium tabular-nums">{money(totals?.lineTotalsCents[i])}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                      {parseDollars(l.price) === null && <span className="rounded bg-rose-50 px-1.5 py-0.5 text-rose-700">Needs price</span>}
                      {l.qtyToConfirm && l.qty === l.originalQty && <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-800">{l.unit === "hour" ? "Hours" : "Quantity"} to confirm — not in the message</span>}
                      {l.sourceKind === "photo" && <span className="rounded bg-sky-50 px-1.5 py-0.5 text-sky-800">From photo — check</span>}
                      <label className="flex items-center gap-1 text-slate-600"><input type="checkbox" checked={l.optional} onChange={(e) => update(l.key, { optional: e.target.checked })} />Optional</label>
                      {l.suggestions?.length ? (
                        <span className="flex flex-wrap items-center gap-1 text-slate-600">Did you mean:
                          {l.suggestions.map((s) => <button key={s.id} className="rounded border px-1.5 py-0.5 hover:bg-slate-50" onClick={() => pick(l.key, s.id)}>{s.name}</button>)}
                        </span>
                      ) : null}
                      {!l.priceBookItemId && typeof parseDollars(l.price) === "number" && l.description.trim() && (
                        <button className="rounded border px-1.5 py-0.5 text-teal-700 hover:bg-slate-50" onClick={() => addToBook(l)}>Add to price book</button>
                      )}
                      {!l.priceBookItemId && book.length > 0 && (
                        <select aria-label="Price from book" className="rounded border px-1 py-0.5" value="" onChange={(e) => e.target.value && pick(l.key, e.target.value)}>
                          <option value="">Price from book…</option>
                          {book.filter((b) => b.active && b.kind !== "assembly").map((b) => <option key={b.id} value={b.id}>{b.name}{b.rateCents == null ? " (no rate)" : ""}</option>)}
                        </select>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          {!locked && <button className={`${btnGhost} mt-3`} onClick={addLine}>+ Add line</button>}

          <div className="mt-6 rounded-lg border bg-white p-4 text-sm">
            <div className="flex items-center justify-between gap-3"><span>Discount</span>
              <input aria-label="Discount" inputMode="decimal" className={`${input} w-28 text-right ${discountCents === "invalid" ? "border-rose-400" : ""}`} value={discount} onChange={(e) => { setDiscount(e.target.value); setDirty(true); }} placeholder="0.00" /></div>
            <div className="mt-2 flex items-center justify-between gap-3"><span>Deposit %</span>
              <input aria-label="Deposit percent" inputMode="numeric" className={`${input} w-28 text-right ${depositValid ? "" : "border-rose-400"}`} value={deposit} onChange={(e) => { setDeposit(e.target.value); setDirty(true); }} /></div>
            {totals && (
              <dl className="mt-3 space-y-1 tabular-nums">
                <Row label="Subtotal" value={money(totals.subtotalCents)} />
                {totals.discountCents > 0 && <Row label="Discount" value={`−${money(totals.discountCents)}`} />}
                {totals.taxes.map((t) => <Row key={t.name} label={t.name} value={money(t.amountCents)} />)}
                <Row label="Total" value={money(totals.totalCents)} strong />
                {totals.optionalTotalCents > 0 && <Row label="Optional extras (not in total)" value={money(totals.optionalTotalCents)} />}
                {!totals.complete && <p className="pt-1 text-xs text-rose-700">Incomplete: {totals.discountExceedsSubtotal ? "discount is larger than the subtotal" : `${totals.unpricedLines} line(s) still need a price`}.</p>}
              </dl>
            )}
          </div>

          </fieldset>
          <QuoteActions quote={quote} dirty={dirty} onChange={load} />
          {quote.jobId && <p className="mt-4 text-xs"><Link className="text-teal-700" href="/jobs">← Back to jobs</Link></p>}
        </section>
      </div>
    </Shell>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return <div className={`flex justify-between ${strong ? "border-t pt-1 text-base font-semibold" : ""}`}><dt>{label}</dt><dd>{value}</dd></div>;
}
