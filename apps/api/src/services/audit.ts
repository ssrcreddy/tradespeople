import type { Tx } from "../db/client.ts";
import { auditEvents } from "../db/schema.ts";

// Written in the same transaction as the change it records (design §23).
export async function audit(
  tx: Tx, businessId: string, actor: string,
  entity: string, entityId: string, action: string, diff?: unknown,
) {
  await tx.insert(auditEvents).values({ businessId, actor, entity, entityId, action, diff: diff ?? null });
}
