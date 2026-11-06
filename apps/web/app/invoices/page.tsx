"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, money } from "@/lib/api";
import { ErrorNote, Shell, useAuthRedirect } from "@/components/Shell";
import { InvoiceChip, type InvoiceRow } from "@/components/InvoiceBits";

export default function Invoices() {
  const onAuth = useAuthRedirect();
  const [rows, setRows] = useState<InvoiceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<InvoiceRow[]>("/invoices").then(setRows).catch((e) => { if (!onAuth(e)) setError((e as Error).message); });
  }, [onAuth]);

  return (
    <Shell title="Invoices">
      <ErrorNote error={error} />
      {rows && rows.length === 0 && <p className="text-sm text-slate-500">No invoices yet. They start from an accepted quote.</p>}
      {!rows && !error && <p className="text-sm text-slate-500">Loading…</p>}
      {rows && rows.length > 0 && (
        <ul className="divide-y rounded-lg border bg-white">
          {rows.map((i) => (
            <li key={i.id}>
              <Link href={`/invoices/${i.id}`} className="flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-slate-50">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{i.ref} · {i.customerName}</span>
                  <span className="text-xs text-slate-500">{i.kind === "deposit" ? "Deposit" : "Invoice"} for {i.quoteRef}{i.dueDate ? ` · due ${i.dueDate}` : ""}{i.remindersSent ? ` · ${i.remindersSent} reminder${i.remindersSent > 1 ? "s" : ""} sent` : ""}</span>
                </span>
                <span className="flex items-center gap-2 text-sm tabular-nums">{money(i.balanceCents)}<InvoiceChip row={i} /></span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}
