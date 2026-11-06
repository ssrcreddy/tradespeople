"use client";
// What can happen next to a quote, by status (design §14, §19). The server
// enforces all of this; the buttons only offer what it would accept.
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, ApiError, money } from "@/lib/api";
import { ErrorNote, btnGhost, btnPrimary } from "@/components/Shell";

export interface QuoteForActions {
  id: string; status: string; lockVersion: number; depositPct: number; lastSendError: string | null; hasPdf: boolean;
  version: number; lines: { id: string; description: string; optional: boolean; lineTotalCents: number | null }[];
}
interface InvoiceRow { id: string; ref: string; kind: string; status: string; amountCents: number; balanceCents: number }

const BLOCKER_TEXT: Record<string, string> = {
  UNPRICED_LINES: "Some lines still need a price.",
  NO_LINES: "Add at least one line that isn't optional.",
  NO_CUSTOMER_CONTACT: "Choose a customer with an email or phone number.",
  NO_TAX_CONFIG: "Set your sales tax in settings.",
  PLAN_LIMIT_REACHED: "You've reached this month's quote limit on your plan.",
};

export function QuoteActions({ quote, dirty, onChange }: { quote: QuoteForActions; dirty: boolean; onChange: () => Promise<void> | void }) {
  const [error, setError] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const { id, status } = quote;

  useEffect(() => {
    if (status === "accepted") api<InvoiceRow[]>(`/quotes/${id}/invoices`).then(setInvoices).catch(() => {});
  }, [id, status]);

  // A send runs in the worker: watch until it leaves `sending`.
  useEffect(() => {
    if (status !== "sending") return;
    const h = setInterval(() => onChange(), 2000);
    return () => clearInterval(h);
  }, [status, onChange]);

  async function run(path: string, json: unknown = {}, after?: (r: any) => void) {
    setBusy(true); setError(null); setBlockers([]);
    try {
      const r = await api(path, { method: "POST", json });
      after?.(r);
      await onChange();
      if (status === "accepted") setInvoices(await api<InvoiceRow[]>(`/quotes/${id}/invoices`));
    } catch (e) {
      const d = e instanceof ApiError ? (e.details as { blockers?: string[] } | undefined) : undefined;
      if (d?.blockers) setBlockers(d.blockers);
      else setError(e instanceof ApiError ? e.message : "That didn't work");
    } finally { setBusy(false); }
  }

  const pdf = <a className={btnGhost} href={`/backend/quotes/${id}/pdf`}>Download PDF</a>;
  const optional = quote.lines.filter((l) => l.optional);

  return (
    <div className="mt-4 space-y-2 rounded-lg border bg-white p-4 text-sm">
      {status === "draft" && (
        <>
          <button className={`${btnPrimary} w-full`} disabled={busy || dirty} onClick={() => run(`/quotes/${id}/approve`, { lockVersion: quote.lockVersion })}>Approve</button>
          {dirty && <p className="text-xs text-slate-500">Save your changes first.</p>}
          <p className="text-xs text-slate-500">Approving freezes this version. Nothing goes to the customer until you send it.</p>
        </>
      )}
      {status === "approved" && (
        <>
          <p className="font-medium">Approved. Ready to send.</p>
          {quote.lastSendError && <p className="rounded bg-rose-50 px-2 py-1 text-rose-700">Last attempt failed: {quote.lastSendError}.</p>}
          <button className={`${btnPrimary} w-full`} disabled={busy || dirty} onClick={() => run(`/quotes/${id}/send`)}>Email to customer</button>
          <button className={`${btnGhost} w-full`} disabled={busy || dirty} onClick={() => run(`/quotes/${id}/share`, {}, (r) => { location.href = `/backend${r.pdfUrl}`; })}>Download PDF and mark as sent</button>
          <p className="text-xs text-slate-500">Changing anything sends this back to draft for re-approval.</p>
        </>
      )}
      {status === "sending" && <p className="text-sky-700">Sending…</p>}
      {(status === "sent" || status === "expired") && (
        <>
          <p className="font-medium">{status === "sent" ? "Sent. What did the customer say?" : "Expired. If they said yes late you can still accept it."}</p>
          {optional.length > 0 && (
            <fieldset className="space-y-1">
              <legend className="text-xs text-slate-500">Optional extras they chose</legend>
              {optional.map((l) => (
                <label key={l.id} className="flex items-center gap-2">
                  <input type="checkbox" checked={chosen.includes(l.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, l.id] : chosen.filter((c) => c !== l.id))} />
                  {l.description} ({money(l.lineTotalCents)})
                </label>
              ))}
            </fieldset>
          )}
          <div className="flex flex-wrap gap-2">
            <button className={btnPrimary} disabled={busy} onClick={() => run(`/quotes/${id}/outcome`, { outcome: "accepted", acceptedOptionalLineIds: chosen })}>Accepted</button>
            {status === "sent" && <button className={btnGhost} disabled={busy} onClick={() => run(`/quotes/${id}/outcome`, { outcome: "declined" })}>Declined</button>}
            <button className={btnGhost} disabled={busy} onClick={() => run(`/quotes/${id}/revise`, {}, (r) => { location.href = `/quotes/${r.id}/review`; })}>Revise</button>
            {pdf}
          </div>
        </>
      )}
      {status === "accepted" && (
        <>
          <p className="font-medium">Accepted.</p>
          <ul className="space-y-1">
            {invoices.map((i) => (
              <li key={i.id}><Link className="text-teal-700" href={`/invoices/${i.id}`}>{i.ref} · {i.kind} · {money(i.amountCents)} · {i.status}</Link></li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            {quote.depositPct > 0 && !invoices.some((i) => i.kind === "deposit" || i.kind === "final") && (
              <button className={btnPrimary} disabled={busy} onClick={() => run(`/quotes/${id}/convert`, { kind: "deposit" })}>Create {quote.depositPct}% deposit invoice</button>
            )}
            {!invoices.some((i) => i.kind === "final") && (
              <button className={quote.depositPct > 0 ? btnGhost : btnPrimary} disabled={busy} onClick={() => run(`/quotes/${id}/convert`, { kind: "final" })}>Create {invoices.length ? "final " : ""}invoice</button>
            )}
            {quote.hasPdf && pdf}
          </div>
        </>
      )}
      {status === "declined" && <div className="flex items-center justify-between"><p>Declined.</p>{quote.hasPdf && pdf}</div>}
      {status === "superseded" && <p>Replaced by a newer version.</p>}

      {blockers.length > 0 && (
        <ul role="alert" className="list-disc rounded bg-rose-50 py-2 pl-6 pr-3 text-rose-700">
          {blockers.map((b) => <li key={b}>{BLOCKER_TEXT[b] ?? b}</li>)}
        </ul>
      )}
      <ErrorNote error={error} />
    </div>
  );
}
