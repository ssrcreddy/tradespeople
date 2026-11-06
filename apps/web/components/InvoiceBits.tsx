"use client";

export interface InvoiceRow {
  id: string; ref: string; kind: string; status: string; quoteRef: string; quoteId: string; customerName: string; customerEmail: string | null;
  amountCents: number; paidCents: number; balanceCents: number; dueDate: string | null; overdue: boolean;
  remindersSent: number; hasPdf: boolean; lastSendError: string | null;
}

const LABEL: Record<string, [string, string]> = {
  issued: ["Not sent", "bg-slate-100 text-slate-700"],
  sending: ["Sending…", "bg-sky-100 text-sky-800"],
  sent: ["Sent", "bg-sky-100 text-sky-800"],
  paid: ["Paid", "bg-teal-100 text-teal-800"],
  void: ["Void", "bg-slate-100 text-slate-500"],
};

export function InvoiceChip({ row }: { row: Pick<InvoiceRow, "status" | "overdue"> }) {
  const [label, cls] = row.overdue ? ["Overdue", "bg-rose-100 text-rose-800"] : LABEL[row.status] ?? [row.status, "bg-slate-100"];
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{label}</span>;
}
