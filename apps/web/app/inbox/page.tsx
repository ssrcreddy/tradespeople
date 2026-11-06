"use client";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { ErrorNote, Shell, btnGhost, btnPrimary, useAuthRedirect } from "@/components/Shell";

interface Held { id: string; from: string; receivedAt: string; disposition: string }

// Mail held back from an unknown sender or a flood (design §15). Nothing here
// has been read by the AI yet.
export default function Inbox() {
  const onAuth = useAuthRedirect();
  const [rows, setRows] = useState<Held[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setRows(await api<Held[]>("/inbox/quarantine")); }
    catch (e) { if (!onAuth(e)) setError((e as Error).message); }
  }, [onAuth]);
  useEffect(() => { load(); }, [load]);

  async function release(id: string, allowSender: boolean) {
    setError(null);
    try { await api(`/inbox/quarantine/${id}/release`, { method: "POST", json: { allowSender } }); await load(); }
    catch (e) { setError(e instanceof ApiError ? e.message : "That didn't work"); }
  }

  return (
    <Shell title="Held email">
      <ErrorNote error={error} />
      {rows?.length === 0 && <p className="text-sm text-slate-500">Nothing held. Email from unknown senders waits here until you approve it.</p>}
      {rows && rows.length > 0 && (
        <ul className="divide-y rounded-lg border bg-white">
          {rows.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm">
              <span className="min-w-0">
                <span className="block truncate font-medium">{m.from}</span>
                <span className="text-xs text-slate-500">{new Date(m.receivedAt).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })}{m.disposition === "rate_limited" ? " · held during a flood" : ""}</span>
              </span>
              <span className="flex gap-2">
                <button className={btnPrimary} onClick={() => release(m.id, false)}>Make this a job</button>
                <button className={btnGhost} onClick={() => release(m.id, true)}>Always allow sender</button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}
