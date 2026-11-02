"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { ErrorNote, Shell, btnPrimary, input, useAuthRedirect } from "@/components/Shell";
import { StatusChip } from "@/components/JobBits";

interface JobRow { id: string; source: string; status: string; subject: string | null; createdAt: string; customerName: string | null; quoteId: string | null }

export default function Jobs() {
  const onAuth = useAuthRedirect();
  const [jobs, setJobs] = useState<JobRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setJobs(await api<JobRow[]>("/jobs")); }
    catch (e) { if (!onAuth(e)) setError((e as Error).message); }
  }, [onAuth]);
  useEffect(() => { load(); }, [load]);
  // Keep polling while anything is still being read.
  useEffect(() => {
    if (!jobs?.some((j) => j.status === "received" || j.status === "extracting")) return;
    const h = setInterval(load, 3000);
    return () => clearInterval(h);
  }, [jobs, load]);

  const attention = jobs?.filter((j) => ["draft_ready", "needs_info", "extraction_failed"].includes(j.status)) ?? [];
  return (
    <Shell>
      <div className="grid gap-6 md:grid-cols-[1fr_380px]">
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Needs your attention</h2>
          <JobList jobs={attention} empty="Nothing waiting. New enquiries appear here as drafts." />
          <h2 className="mb-2 mt-8 text-sm font-semibold uppercase tracking-wide text-slate-500">All jobs</h2>
          <JobList jobs={jobs ?? []} empty={jobs ? "No jobs yet." : "Loading…"} />
          <ErrorNote error={error} />
        </section>
        <NewJob onCreated={load} />
      </div>
    </Shell>
  );
}

function JobList({ jobs, empty }: { jobs: JobRow[]; empty: string }) {
  if (!jobs.length) return <p className="text-sm text-slate-500">{empty}</p>;
  return (
    <ul className="divide-y rounded-lg border bg-white">
      {jobs.map((j) => (
        <li key={j.id}>
          <Link href={j.quoteId ? `/quotes/${j.quoteId}/review` : `/jobs/${j.id}`} className="flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-slate-50">
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{j.customerName ?? j.subject ?? "New enquiry"}</span>
              <span className="text-xs text-slate-500">{j.source.replace("_", " ")} · {new Date(j.createdAt).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })}</span>
            </span>
            <StatusChip status={j.status} />
          </Link>
        </li>
      ))}
    </ul>
  );
}

// Paste, upload or site notes — one form, one pipeline (design §15).
function NewJob({ onCreated }: { onCreated: () => void }) {
  const [text, setText] = useState("");
  const [source, setSource] = useState("paste");
  const [files, setFiles] = useState<FileList | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const form = new FormData();
    form.set("text", text);
    form.set("source", files?.length && source === "paste" ? "upload" : source);
    for (const f of Array.from(files ?? [])) form.append("photo", f);
    try {
      await api("/jobs", { method: "POST", body: form });
      setText(""); setFiles(null); (e.target as HTMLFormElement).reset();
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Upload failed");
    } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="h-fit space-y-3 rounded-lg border bg-white p-4">
      <h2 className="font-semibold">New job</h2>
      <div className="flex gap-3 text-sm">
        {[["paste", "Customer message"], ["site_notes", "My site notes"]].map(([v, l]) => (
          <label key={v} className="flex items-center gap-1"><input type="radio" name="src" checked={source === v} onChange={() => setSource(v!)} />{l}</label>
        ))}
      </div>
      <textarea className={`${input} h-40`} value={text} onChange={(e) => setText(e.target.value)}
        placeholder={source === "site_notes" ? "What you saw on site: items, counts, permit…" : "Paste the customer's email or text thread"} />
      <input type="file" accept="image/*,.heic,.heif" multiple onChange={(e) => setFiles(e.target.files)} className="block w-full text-sm" />
      <ErrorNote error={error} />
      <button className={`${btnPrimary} w-full`} disabled={busy || (!text.trim() && !files?.length)}>{busy ? "Uploading…" : "Create draft"}</button>
      <p className="text-xs text-slate-500">Nothing is sent to the customer until you approve it.</p>
    </form>
  );
}
