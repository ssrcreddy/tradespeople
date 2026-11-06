// Job queue on Postgres (design §7, §14). Jobs are enqueued inside the same
// transaction as the state change that causes them, so a crash can never leave
// a job row without its queued work (§6, §15).
import { PgBoss, fromDrizzle, type SendOptions } from "pg-boss";
import { sql } from "drizzle-orm";
import type { Tx } from "./db/client.ts";

export const Q = {
  fetchInbound: "fetch-inbound",
  extract: "extract",
  notify: "notify",
  stuckSweep: "stuck-sweep",
  sendFailed: "send-failed",      // dead letter for send-document: created first
  sendDocument: "send-document",
  invoiceReminder: "invoice-reminder",
  expirySweep: "expiry-sweep",
  exportBusiness: "export-business",
  deleteBusiness: "delete-business",
} as const;
export type QueueName = (typeof Q)[keyof typeof Q];

const QUEUE_OPTIONS: Record<QueueName, Parameters<PgBoss["createQueue"]>[1]> = {
  [Q.fetchInbound]: { retryLimit: 5, retryDelay: 10, retryBackoff: true, expireInSeconds: 120 },
  [Q.extract]: { retryLimit: 3, retryDelay: 15, retryBackoff: true, expireInSeconds: 300 },
  [Q.notify]: { retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInSeconds: 60 },
  [Q.stuckSweep]: { retryLimit: 0, expireInSeconds: 120 },
  [Q.sendFailed]: { retryLimit: 3, retryDelay: 30, expireInSeconds: 60 },
  [Q.sendDocument]: { retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInSeconds: 120, deadLetter: Q.sendFailed },
  [Q.invoiceReminder]: { retryLimit: 2, retryDelay: 300, expireInSeconds: 120 },
  [Q.expirySweep]: { retryLimit: 0, expireInSeconds: 120 },
  [Q.exportBusiness]: { retryLimit: 2, retryDelay: 60, expireInSeconds: 600 },
  [Q.deleteBusiness]: { retryLimit: 5, retryDelay: 60, retryBackoff: true, expireInSeconds: 600 },
};

export const SCHEMA = "pgboss";

// Admin-only: creates/migrates the pg-boss schema and queues. Run by migrate.ts.
export async function installQueue(adminUrl: string) {
  const boss = new PgBoss({ connectionString: adminUrl, schema: SCHEMA, supervise: false, schedule: false, max: 2 });
  boss.on("error", () => {});
  await boss.start();
  for (const name of Object.values(Q)) await boss.createQueue(name, QUEUE_OPTIONS[name]);
  await boss.stop({ graceful: false });
}

// App-role instance: never runs DDL.
export function createBoss(connectionString: string, opts: { worker: boolean }) {
  const boss = new PgBoss({
    connectionString, schema: SCHEMA, max: 4,
    migrate: false, createSchema: false,
    supervise: opts.worker, schedule: opts.worker,
  });
  return boss;
}

export async function enqueue(boss: PgBoss, tx: Tx, name: QueueName, data: object, opts: Omit<SendOptions, "db"> = {}) {
  return boss.send(name, data, { ...opts, db: fromDrizzle(tx, sql) });
}

export type Boss = PgBoss;
