"use client";

export interface Job {
  id: string; source: string; status: string; subject: string | null; createdAt: string; customerId: string | null;
  originalText: string; contactHint: { name: string | null; email: string | null } | null;
  files: { n: number; filename: string; contentType: string; size: number; preview: boolean }[];
  summary: string | null; urgency: string | null; questions: string[]; lastError: string | null; quoteId: string | null;
}

export const STATUS: Record<string, [string, string]> = {
  received: ["Received", "bg-slate-100 text-slate-700"],
  extracting: ["Reading…", "bg-sky-100 text-sky-800"],
  draft_ready: ["Draft ready", "bg-teal-100 text-teal-800"],
  in_review: ["In review", "bg-teal-100 text-teal-800"],
  needs_info: ["Needs info", "bg-amber-100 text-amber-800"],
  extraction_failed: ["Couldn't read", "bg-rose-100 text-rose-800"],
  closed: ["Closed", "bg-slate-100 text-slate-500"],
};

export function StatusChip({ status }: { status: string }) {
  const [label, cls] = STATUS[status] ?? [status, "bg-slate-100"];
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{label}</span>;
}

export function Original({ job, children }: { job: Job; children?: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <div className="whitespace-pre-wrap rounded-lg border bg-white p-4 text-sm leading-relaxed">{children ?? (job.originalText || <em className="text-slate-400">(no text)</em>)}</div>
      {job.files.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {job.files.map((f) => f.preview
            ? <a key={f.n} href={`/backend/jobs/${job.id}/files/${f.n}`} target="_blank"><img alt={f.filename} src={`/backend/jobs/${job.id}/files/${f.n}`} className="aspect-square w-full rounded-md border object-cover" /></a>
            : <a key={f.n} href={`/backend/jobs/${job.id}/files/${f.n}?variant=original`} className="rounded-md border bg-white p-3 text-xs">{f.filename}</a>)}
        </div>
      )}
    </div>
  );
}
