"use client";
// Onboarding (design §22): business + tax → price book → first draft. It ends
// when a real draft exists: seeing one is the point of the product.
import { useEffect, useState } from "react";
import { api, ApiError, dollarsOf, parseDollars } from "@/lib/api";
import { ErrorNote, Shell, btnGhost, btnPrimary, input } from "@/components/Shell";

const PRESETS = [
  ["ON-HST", "Ontario — HST 13%"], ["NS-HST", "Nova Scotia — HST 14%"], ["BC-GST-PST", "British Columbia — GST 5% + PST 7%"],
  ["QC-GST-QST", "Québec — GST 5% + QST 9.975%"], ["AB-GST", "Alberta — GST 5%"],
] as const;

const SAMPLE = `Hi, we need a Level 2 charger put in the garage for our new EV. Also the plug by the kitchen sink has no safety button, can you swap it? Thanks, Sam`;

interface Item { id: string; name: string; kind: string; unit: string; rateCents: number | null }

export default function Onboarding() {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [intake, setIntake] = useState("");
  return (
    <Shell>
      <ol className="mb-6 flex gap-4 text-sm">
        {["Your business", "Your rates", "Your first draft"].map((l, i) => (
          <li key={l} className={i + 1 === step ? "font-semibold text-teal-800" : "text-slate-400"}>{i + 1}. {l}</li>
        ))}
      </ol>
      {step === 1 && <BusinessStep onDone={(a) => { setIntake(a); setStep(2); }} />}
      {step === 2 && <RatesStep onDone={() => setStep(3)} />}
      {step === 3 && <FirstDraftStep intake={intake} />}
    </Shell>
  );
}

function BusinessStep({ onDone }: { onDone: (intake: string) => void }) {
  const [name, setName] = useState("");
  const [taxPreset, setTaxPreset] = useState<string>("ON-HST");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const b = await api("/businesses", { method: "POST", json: { name, taxPreset } });
      await api("/price-book/starter", { method: "POST" });
      onDone(b.intakeAddress);
    } catch (err) {
      if (err instanceof ApiError && err.code === "ALREADY_IN_BUSINESS") { location.href = "/jobs"; return; }
      setError(err instanceof ApiError ? err.message : "Something went wrong");
    }
  }
  return (
    <form onSubmit={submit} className="max-w-lg space-y-4">
      <label className="block text-sm">Business name<input className={input} required value={name} onChange={(e) => setName(e.target.value)} placeholder="Dan's Electric" /></label>
      <label className="block text-sm">Sales tax
        <select className={input} value={taxPreset} onChange={(e) => setTaxPreset(e.target.value)}>
          {PRESETS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
      <p className="text-xs text-slate-500">The tool applies the rate you choose; it doesn't decide your tax obligations.</p>
      <ErrorNote error={error} />
      <button className={btnPrimary}>Continue</button>
    </form>
  );
}

// The rates that matter most, in one table. The full book is under Price book.
function RatesStep({ onDone }: { onDone: () => void }) {
  const [items, setItems] = useState<Item[]>([]);
  const [rates, setRates] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Item[]>("/price-book").then((all) => {
      const rows = all.filter((i) => i.kind !== "assembly");
      setItems(rows);
      setRates(Object.fromEntries(rows.map((i) => [i.id, dollarsOf(i.rateCents)])));
    }).catch((e) => setError((e as Error).message));
  }, []);

  async function save() {
    setError(null);
    const entries = items.flatMap((i) => {
      const c = parseDollars(rates[i.id] ?? "");
      return c !== "invalid" && c !== i.rateCents ? [[i.id, c] as const] : [];
    });
    if (items.some((i) => parseDollars(rates[i.id] ?? "") === "invalid")) { setError("Check the highlighted amounts"); return; }
    try {
      for (const [id, rateCents] of entries) await api(`/price-book/${id}`, { method: "PATCH", json: { rateCents } });
      onDone();
    } catch (e) { setError(e instanceof ApiError ? e.message : "Couldn't save"); }
  }

  return (
    <div className="max-w-xl space-y-3">
      <p className="text-sm text-slate-600">Quotes are priced only from your own rates. Fill in what you know; anything blank shows up as "needs price" on a draft, and you can set it then. Labour hours for common jobs are under Price book → Assemblies.</p>
      <ul className="divide-y rounded-lg border bg-white">
        {items.map((i) => (
          <li key={i.id} className="flex items-center justify-between gap-3 px-3 py-1.5 text-sm">
            <span>{i.name} <span className="text-slate-500">/ {i.unit}</span></span>
            <input aria-label={`Rate for ${i.name}`} inputMode="decimal" placeholder="0.00"
              className={`${input} w-24 text-right ${parseDollars(rates[i.id] ?? "") === "invalid" ? "border-rose-400" : ""}`}
              value={rates[i.id] ?? ""} onChange={(e) => setRates({ ...rates, [i.id]: e.target.value })} />
          </li>
        ))}
      </ul>
      <ErrorNote error={error} />
      <button className={btnPrimary} onClick={save}>Continue</button>
    </div>
  );
}

function FirstDraftStep({ intake }: { intake: string }) {
  const [text, setText] = useState(SAMPLE);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Waits for the worker; a draft sends the owner straight to the review screen.
  useEffect(() => {
    if (!jobId) return;
    const h = setInterval(async () => {
      const j = await api(`/jobs/${jobId}`).catch(() => null);
      if (j?.quoteId) location.href = `/quotes/${j.quoteId}/review`;
      else if (j && !["received", "extracting"].includes(j.status)) location.href = `/jobs/${jobId}`;
    }, 2000);
    return () => clearInterval(h);
  }, [jobId]);

  async function go() {
    setError(null);
    try { setJobId((await api("/jobs", { method: "POST", json: { text, source: "paste" } })).id); }
    catch (e) { setError(e instanceof ApiError ? e.message : "Couldn't create the job"); }
  }

  return (
    <div className="max-w-xl space-y-4 text-sm">
      <div>
        <p className="mb-1 font-medium">Try it on a real enquiry</p>
        <p className="mb-2 text-slate-600">Paste an old customer message, or use this one. Nothing is sent to anyone.</p>
        <textarea aria-label="Enquiry" className={`${input} h-32`} value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <ErrorNote error={error} />
      {jobId ? <p className="text-sky-700">Reading the message…</p>
        : <button className={btnPrimary} disabled={!text.trim()} onClick={go}>Make my first draft</button>}
      <div className="rounded-lg border bg-white p-3">
        <p className="mb-1 font-medium">Then forward enquiries to</p>
        <p className="break-all font-mono text-xs">{intake}</p>
      </div>
      <a className={btnGhost} href="/jobs">Skip for now</a>
    </div>
  );
}
