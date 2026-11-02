"use client";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { ErrorNote, Shell, btnPrimary, input } from "@/components/Shell";

const PRESETS = [
  ["ON-HST", "Ontario — HST 13%"], ["NS-HST", "Nova Scotia — HST 14%"], ["BC-GST-PST", "British Columbia — GST 5% + PST 7%"],
  ["QC-GST-QST", "Québec — GST 5% + QST 9.975%"], ["AB-GST", "Alberta — GST 5%"],
] as const;

// v1 onboarding (design §22): business + tax → starter price book → intake address.
// The full flow with the test-enquiry moment lands on Days 16–21.
export default function Onboarding() {
  const [name, setName] = useState("");
  const [taxPreset, setTaxPreset] = useState<string>("ON-HST");
  const [starter, setStarter] = useState(true);
  const [done, setDone] = useState<{ intakeAddress: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const b = await api("/businesses", { method: "POST", json: { name, taxPreset } });
      if (starter) await api("/price-book/starter", { method: "POST" });
      setDone(b);
    } catch (err) {
      if (err instanceof ApiError && err.code === "ALREADY_IN_BUSINESS") { location.href = "/jobs"; return; }
      setError(err instanceof ApiError ? err.message : "Something went wrong");
    }
  }

  return (
    <Shell title="Set up your business">
      {done ? (
        <div className="max-w-lg space-y-4">
          <p>Forward customer enquiries to:</p>
          <p className="rounded bg-white p-3 font-mono text-sm shadow-sm">{done.intakeAddress}</p>
          <p className="text-sm text-slate-600">
            {starter ? "Your price book has the electrical starter items with blank rates — fill in your own before your first quote. " : ""}
            Or paste an old enquiry on the Jobs page to try it now.
          </p>
          <a className={btnPrimary} href="/jobs">Go to jobs</a>
        </div>
      ) : (
        <form onSubmit={submit} className="max-w-lg space-y-4">
          <label className="block text-sm">Business name
            <input className={input} required value={name} onChange={(e) => setName(e.target.value)} placeholder="Dan's Electric" />
          </label>
          <label className="block text-sm">Sales tax
            <select className={input} value={taxPreset} onChange={(e) => setTaxPreset(e.target.value)}>
              {PRESETS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <p className="text-xs text-slate-500">The tool applies the rate you choose; it doesn't decide your tax obligations.</p>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={starter} onChange={(e) => setStarter(e.target.checked)} />
            Start from the electrical price book template (rates left blank)
          </label>
          <ErrorNote error={error} />
          <button className={btnPrimary}>Create business</button>
        </form>
      )}
    </Shell>
  );
}
