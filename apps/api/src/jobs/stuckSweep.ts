// stuck-sweep (design §14): the safety net behind transactional enqueue.
// Re-drives jobs left in received/extracting (e.g. a worker killed mid-call).
// Handlers are idempotent and singleton-keyed, so a duplicate is harmless.
import { withTenant } from "../db/client.ts";
import { enqueue, Q } from "../queue.ts";
import type { WorkerDeps } from "./deps.ts";

export async function stuckSweep(d: WorkerDeps, opts = { receivedMinutes: 5, extractingMinutes: 10 }) {
  const { rows } = await d.pool.query<{ id: string; business_id: string; status: string; needs_fetch: boolean }>(
    "select * from app_stuck_jobs($1, $2)", [opts.receivedMinutes, opts.extractingMinutes]);
  for (const r of rows) {
    await withTenant(d.db, r.business_id, (tx) => r.needs_fetch
      ? enqueue(d.boss, tx, Q.fetchInbound, { businessId: r.business_id, jobId: r.id }, { singletonKey: `fetch:${r.id}` })
      : enqueue(d.boss, tx, Q.extract, { businessId: r.business_id, jobId: r.id }, { singletonKey: `extract:${r.id}` }));
  }
  return { redriven: rows.length };
}
