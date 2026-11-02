"use client";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { ErrorNote, Shell, btnGhost, btnPrimary, useAuthRedirect } from "@/components/Shell";
import { StatusChip, Original, type Job } from "@/components/JobBits";

// Jobs without a draft: still being read, needs info, failed, or not a job.
export default function JobPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const onAuth = useAuthRedirect();
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const j = await api<Job>(`/jobs/${id}`);
      if (j.quoteId) { router.replace(`/quotes/${j.quoteId}/review`); return; }
      setJob(j);
    } catch (e) { if (!onAuth(e)) setError((e as Error).message); }
  }, [id, onAuth, router]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (job?.status !== "received" && job?.status !== "extracting") return;
    const h = setInterval(load, 2500);
    return () => clearInterval(h);
  }, [job, load]);

  async function act(path: string) {
    setError(null);
    try {
      const r = await api(path, { method: "POST" });
      if (r?.id && path.endsWith("/quote")) router.push(`/quotes/${r.id}/review`); else load();
    } catch (e) { setError(e instanceof ApiError ? e.message : "Failed"); }
  }

  if (!job) return <Shell><ErrorNote error={error} />{!error && <p className="text-sm text-slate-500">Loading…</p>}</Shell>;
  return (
    <Shell>
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-xl font-semibold">{job.contactHint?.name ?? job.subject ?? "Enquiry"}</h1>
        <StatusChip status={job.status} />
      </div>
      {job.status === "needs_info" && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <p className="mb-2 font-medium">Not enough to quote yet. Ask the customer:</p>
          <ul className="list-disc pl-5 text-sm">{job.questions.map((q) => <li key={q}>{q}</li>)}</ul>
        </div>
      )}
      {job.status === "extraction_failed" && (
        <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm">We couldn't turn this into a draft. You can try again or start the quote by hand.</div>
      )}
      {(job.status === "received" || job.status === "extracting") && <p className="mb-4 text-sm text-sky-700">Reading the message… this usually takes under a minute.</p>}
      <div className="mb-6 flex flex-wrap gap-2">
        {job.status === "extraction_failed" && <button className={btnGhost} onClick={() => act(`/jobs/${id}/retry`)}>Try again</button>}
        {["needs_info", "extraction_failed", "closed"].includes(job.status) && <button className={btnPrimary} onClick={() => act(`/jobs/${id}/quote`)}>Start the quote by hand</button>}
      </div>
      <ErrorNote error={error} />
      <Original job={job} />
    </Shell>
  );
}
