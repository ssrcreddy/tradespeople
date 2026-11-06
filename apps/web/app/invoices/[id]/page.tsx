"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, money, parseDollars } from "@/lib/api";
import { ErrorNote, Shell, btnGhost, btnPrimary, input, useAuthRedirect } from "@/components/Shell";
import { InvoiceChip, type InvoiceRow } from "@/components/InvoiceBits";

interface Invoice extends InvoiceRow {
  totalCents: number; lessDepositCents: number;
  payments: { id: string; amountCents: number; method: string; receivedOn: string; note: string | null }[];
}

export default function InvoicePage() {
  const { id } = useParams<{ id: string }>();
  const onAuth = useAuthRedirect();
  const [inv, setInv] = useState<Invoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("e-transfer");
  const [receivedOn, setReceivedOn] = useState(() => new Date().toLocaleDateString("en-CA"));
  // One key per intended payment: a double-tap or retry records it once.
  const [payKey, setPayKey] = useState(() => crypto.randomUUID());

  const load = useCallback(async () => {
    try { setInv(await api<Invoice>(`/invoices/${id}`)); }
    catch (e) { if (!onAuth(e)) setError((e as Error).message); }
  }, [id, onAuth]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (inv?.status !== "sending") return;
    const h = setInterval(load, 2000);
    return () => clearInterval(h);
  }, [inv, load]);

  async function act(path: string, json: unknown = {}, after?: (r: any) => void) {
    setBusy(true); setError(null);
    try { const r = await api(path, { method: "POST", json }); after?.(r); await load(); }
    catch (e) { setError(e instanceof ApiError ? e.message : "That didn't work"); }
    finally { setBusy(false); }
  }

  if (!inv) return <Shell><ErrorNote error={error} />{!error && <p className="text-sm text-slate-500">Loading…</p>}</Shell>;
  const cents = parseDollars(amount);
  const canPay = typeof cents === "number" && cents > 0;
  return (
    <Shell>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{inv.kind === "deposit" ? "Deposit invoice" : "Invoice"} {inv.ref}</h1>
        <InvoiceChip row={inv} />
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        <section className="space-y-1 rounded-lg border bg-white p-4 text-sm tabular-nums">
          <p className="font-medium">{inv.customerName}</p>
          <p className="text-slate-600">For <Link className="text-teal-700" href={`/quotes/${inv.quoteId}/review`}>{inv.quoteRef}</Link>{inv.dueDate ? ` · due ${inv.dueDate}` : ""}</p>
          <dl className="mt-3 space-y-1">
            <div className="flex justify-between"><dt>Total</dt><dd>{money(inv.totalCents)}</dd></div>
            {inv.lessDepositCents > 0 && <div className="flex justify-between"><dt>Less deposit</dt><dd>−{money(inv.lessDepositCents)}</dd></div>}
            <div className="flex justify-between"><dt>Amount due</dt><dd>{money(inv.amountCents)}</dd></div>
            <div className="flex justify-between"><dt>Paid</dt><dd>{money(inv.paidCents)}</dd></div>
            <div className="flex justify-between border-t pt-1 text-base font-semibold"><dt>Balance</dt><dd>{money(inv.balanceCents)}</dd></div>
          </dl>
          {inv.remindersSent > 0 && <p className="pt-2 text-xs text-slate-500">{inv.remindersSent} reminder{inv.remindersSent > 1 ? "s" : ""} sent.</p>}
          {inv.overdue && inv.remindersSent >= 2 && <p className="pt-1 text-xs text-rose-700">Both reminders have gone out. This one needs a phone call.</p>}
        </section>

        <section className="space-y-3">
          {inv.lastSendError && <p className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">Last attempt failed: {inv.lastSendError}.</p>}
          {inv.status === "issued" && (
            <div className="flex flex-wrap gap-2">
              <button className={btnPrimary} disabled={busy || !inv.customerEmail} onClick={() => act(`/invoices/${id}/send`)}>Email to customer</button>
              <button className={btnGhost} disabled={busy} onClick={() => act(`/invoices/${id}/share`, {}, (r) => { location.href = `/backend${r.pdfUrl}`; })}>Download PDF and mark as sent</button>
            </div>
          )}
          {inv.status === "sending" && <p className="text-sm text-sky-700">Sending…</p>}
          {inv.hasPdf && <a className={btnGhost} href={`/backend/invoices/${id}/pdf`}>Download PDF</a>}
          {(inv.status === "sent" || inv.status === "paid") && inv.balanceCents > 0 && (
            <form className="space-y-2 rounded-lg border bg-white p-4 text-sm"
              onSubmit={(e) => { e.preventDefault(); if (canPay) act(`/invoices/${id}/payments`, { amountCents: cents, method, receivedOn, idempotencyKey: payKey }, () => { setAmount(""); setPayKey(crypto.randomUUID()); }); }}>
              <p className="font-medium">Record a payment</p>
              <div className="grid grid-cols-2 gap-2">
                <input aria-label="Amount" inputMode="decimal" className={input} placeholder={(inv.balanceCents / 100).toFixed(2)} value={amount} onChange={(e) => setAmount(e.target.value)} />
                <select aria-label="Method" className={input} value={method} onChange={(e) => setMethod(e.target.value)}>
                  {["e-transfer", "cheque", "cash", "card", "other"].map((m) => <option key={m}>{m}</option>)}
                </select>
              </div>
              <input aria-label="Date received" type="date" className={input} value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} />
              <button className={btnPrimary} disabled={busy || !canPay}>Record payment</button>
            </form>
          )}
          <ErrorNote error={error} />
          {inv.payments.length > 0 && (
            <ul className="divide-y rounded-lg border bg-white text-sm">
              {inv.payments.map((p) => (
                <li key={p.id} className="flex justify-between px-3 py-2 tabular-nums"><span>{p.receivedOn} · {p.method}</span><span>{money(p.amountCents)}</span></li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Shell>
  );
}
