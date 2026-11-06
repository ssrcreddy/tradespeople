import { withTenant } from "../db/client.ts";
import { buildExport, deleteBusiness } from "../services/exportDelete.ts";
import { notifyOwners } from "../services/notify.ts";
import type { WorkerDeps } from "./deps.ts";

export async function exportBusiness(d: WorkerDeps, data: { businessId: string }) {
  const r = await buildExport(d.db, d.store, data.businessId);
  await withTenant(d.db, data.businessId, (tx) => notifyOwners(d.boss, tx, data.businessId, "export_ready", `export:${r.key}`));
  return r;
}

export async function deleteBusinessJob(d: WorkerDeps, data: { businessId: string }) {
  if (!d.adminDatabaseUrl) throw new Error("DATABASE_ADMIN_URL is required to delete a business");
  return deleteBusiness(d.adminDatabaseUrl, d.store, data.businessId);
}
