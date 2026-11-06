// expiry-sweep (design §14): daily. Sent quotes past their date become expired;
// the owner can still mark one accepted if the customer says yes late.
import { withTenant } from "../db/client.ts";
import { expireQuote } from "../services/quoteActions.ts";
import { notifyOwners } from "../services/notify.ts";
import type { WorkerDeps } from "./deps.ts";

export async function expirySweep(d: WorkerDeps) {
  const { rows } = await d.pool.query<{ business_id: string; quote_id: string }>("select * from app_expired_quotes()");
  for (const r of rows) {
    await withTenant(d.db, r.business_id, async (tx) => {
      await expireQuote(tx, r.business_id, r.quote_id);
      await notifyOwners(d.boss, tx, r.business_id, "quote_expired", `quote:${r.quote_id}`);
    });
  }
  return { expired: rows.length };
}
