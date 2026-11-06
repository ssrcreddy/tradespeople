"use client";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { ErrorNote, Shell, btnGhost, btnPrimary, input, useAuthRedirect } from "@/components/Shell";

interface Tax { name: string; ratePpm: number; regNo: string | null }
interface Settings {
  name: string; taxComponents: Tax[]; timezone: string; replyToEmail: string | null; senderAllowlist: string[];
  termsDays: number; quoteExpiryDays: number; depositPctDefault: number; collapseAssemblies: boolean;
  intakeAddress: string; exportAvailable: boolean; lastExportAt: string | null;
}

const urlKey = (k: string) => Uint8Array.from(atob(k.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(k.length / 4) * 4, "=")), (c) => c.charCodeAt(0));

export default function SettingsPage() {
  const onAuth = useAuthRedirect();
  const [s, setS] = useState<Settings | null>(null);
  const [allow, setAllow] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirmName, setConfirmName] = useState("");
  const [waive, setWaive] = useState(false);

  const load = useCallback(async () => {
    try {
      const v = await api<Settings>("/settings/business");
      setS(v); setAllow(v.senderAllowlist.join(", "));
    } catch (e) { if (!onAuth(e)) setError((e as Error).message); }
  }, [onAuth]);
  useEffect(() => { load(); }, [load]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!s) return;
    setError(null); setSaved(false);
    try {
      await api("/settings/business", {
        method: "PATCH",
        json: {
          name: s.name, taxComponents: s.taxComponents, timezone: s.timezone, replyToEmail: s.replyToEmail || null,
          senderAllowlist: allow.split(",").map((a) => a.trim()).filter(Boolean),
          termsDays: s.termsDays, quoteExpiryDays: s.quoteExpiryDays, depositPctDefault: s.depositPctDefault, collapseAssemblies: s.collapseAssemblies,
        },
      });
      setSaved(true);
    } catch (err) { setError(err instanceof ApiError ? err.message : "Couldn't save"); }
  }

  async function rotate() {
    if (!confirm("Change your intake address? The old one stops working immediately, so update any forwarding rules.")) return;
    try { await api("/settings/rotate-intake", { method: "POST" }); await load(); }
    catch (e) { setError(e instanceof ApiError ? e.message : "That didn't work"); }
  }

  async function enablePush() {
    setNote(null);
    try {
      const { publicKey } = await api<{ publicKey: string | null }>("/push/public-key");
      if (!publicKey) { setNote("Phone notifications aren't set up on this server yet. You'll still get emails."); return; }
      if ((await Notification.requestPermission()) !== "granted") { setNote("Notifications are blocked in your browser settings."); return; }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlKey(publicKey) });
      await api("/push/subscribe", { method: "POST", json: sub.toJSON() });
      setNote("Notifications are on for this device.");
    } catch { setNote("This browser can't do notifications. You'll still get emails."); }
  }

  async function exportData() {
    setNote(null);
    try { await api("/settings/export", { method: "POST" }); setNote("Your export is being prepared. We'll email you when it's ready."); }
    catch (e) { setError(e instanceof ApiError ? e.message : "That didn't work"); }
  }

  async function deleteBusiness() {
    setError(null);
    try {
      await api("/settings/business", { method: "DELETE", json: { confirmName, exportWaived: waive } });
      location.href = "/login";
    } catch (e) { setError(e instanceof ApiError ? e.message : "That didn't work"); }
  }

  if (!s) return <Shell><ErrorNote error={error} />{!error && <p className="text-sm text-slate-500">Loading…</p>}</Shell>;
  const num = (k: "termsDays" | "quoteExpiryDays" | "depositPctDefault") => (e: React.ChangeEvent<HTMLInputElement>) => setS({ ...s, [k]: Number(e.target.value) });

  return (
    <Shell title="Settings">
      <div className="max-w-xl space-y-8 text-sm">
        <form onSubmit={save} className="space-y-3">
          <label className="block">Business name<input className={input} value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} /></label>
          <fieldset className="space-y-2 rounded-lg border bg-white p-3">
            <legend className="px-1 text-xs text-slate-500">Sales tax, printed on your documents as entered</legend>
            {s.taxComponents.map((t, i) => (
              <div key={i} className="grid grid-cols-3 gap-2">
                <span className="self-center">{t.name} {t.ratePpm / 10_000}%</span>
                <input aria-label={`${t.name} registration number`} className={`${input} col-span-2`} placeholder="Registration number" value={t.regNo ?? ""}
                  onChange={(e) => setS({ ...s, taxComponents: s.taxComponents.map((x, n) => (n === i ? { ...x, regNo: e.target.value || null } : x)) })} />
              </div>
            ))}
            <p className="text-xs text-slate-500">The tool applies the rates you set; it doesn't decide your tax obligations.</p>
          </fieldset>
          <label className="block">Customer replies go to<input type="email" className={input} value={s.replyToEmail ?? ""} onChange={(e) => setS({ ...s, replyToEmail: e.target.value })} /></label>
          <div className="grid grid-cols-3 gap-2">
            <label>Invoice terms (days)<input type="number" min={0} max={365} className={input} value={s.termsDays} onChange={num("termsDays")} /></label>
            <label>Quote valid (days)<input type="number" min={1} max={365} className={input} value={s.quoteExpiryDays} onChange={num("quoteExpiryDays")} /></label>
            <label>Default deposit %<input type="number" min={0} max={100} className={input} value={s.depositPctDefault} onChange={num("depositPctDefault")} /></label>
          </div>
          <label className="block">Timezone<input className={input} value={s.timezone} onChange={(e) => setS({ ...s, timezone: e.target.value })} /></label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={s.collapseAssemblies} onChange={(e) => setS({ ...s, collapseAssemblies: e.target.checked })} />Show assemblies as one priced line on PDFs</label>
          <label className="block">Addresses allowed to forward to your intake address
            <input className={input} value={allow} onChange={(e) => setAllow(e.target.value)} placeholder="you@example.com, office@example.com" />
          </label>
          <ErrorNote error={error} />
          <button className={btnPrimary}>Save</button>
          {saved && <span className="ml-3 text-teal-700">Saved</span>}
        </form>

        <section className="space-y-2">
          <h2 className="font-semibold">Intake address</h2>
          <p className="break-all rounded bg-white p-2 font-mono text-xs shadow-sm">{s.intakeAddress}</p>
          <button className={btnGhost} onClick={rotate}>Change address</button>
        </section>

        <section className="space-y-2">
          <h2 className="font-semibold">Phone notifications</h2>
          <button className={btnGhost} onClick={enablePush}>Turn on for this device</button>
        </section>

        <section className="space-y-2">
          <h2 className="font-semibold">Your data</h2>
          <p className="text-xs text-slate-500">A zip of your customers, quotes, invoices, payments and every PDF. Keep invoice records for as long as tax law requires.</p>
          <div className="flex gap-2">
            <button className={btnGhost} onClick={exportData}>Prepare an export</button>
            {s.exportAvailable && <a className={btnGhost} href="/backend/settings/export/latest">Download latest</a>}
          </div>
          {note && <p className="text-teal-700">{note}</p>}
        </section>

        <section className="space-y-2 rounded-lg border border-rose-200 p-3">
          <h2 className="font-semibold text-rose-700">Delete this business</h2>
          <p className="text-xs text-slate-600">Permanently removes all customers, quotes, invoices and files. It can't be undone. Backups age out within 14 days.</p>
          <input aria-label="Type the business name to confirm" className={input} placeholder={`Type "${s.name}" to confirm`} value={confirmName} onChange={(e) => setConfirmName(e.target.value)} />
          <label className="flex items-center gap-2"><input type="checkbox" checked={waive} onChange={(e) => setWaive(e.target.checked)} />I don't need an export</label>
          <button className="rounded-md bg-rose-700 px-3 py-2 font-medium text-white disabled:opacity-40" disabled={confirmName.trim() !== s.name} onClick={deleteBusiness}>Delete everything</button>
        </section>
      </div>
    </Shell>
  );
}
