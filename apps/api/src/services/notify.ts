// Owner notifications (design §1, §5, §14): a row per owner per event, deduped
// on (kind, entity), then an async job sends it. Never blocks the change that
// caused it — the send happens in the worker.
import { and, eq } from "drizzle-orm";
import type { Tx } from "../db/client.ts";
import { memberships, notifications } from "../db/schema.ts";
import { enqueue, Q, type Boss } from "../queue.ts";

export type NotifyKind = "draft_ready" | "needs_info" | "extraction_failed" | "quarantined" | "rate_limited" | "spend_cap"
  | "send_failed" | "bounced" | "quote_expired" | "export_ready";

export async function notifyOwners(boss: Boss, tx: Tx, businessId: string, kind: NotifyKind, entityId: string) {
  const owners = await tx.select({ userId: memberships.userId }).from(memberships)
    .where(and(eq(memberships.businessId, businessId), eq(memberships.role, "owner")));
  for (const o of owners) {
    const [row] = await tx.insert(notifications)
      .values({ businessId, userId: o.userId, kind, entityId, channel: "email" })
      .onConflictDoNothing()
      .returning({ id: notifications.id });
    if (row) await enqueue(boss, tx, Q.notify, { businessId, notificationId: row.id });
  }
}
