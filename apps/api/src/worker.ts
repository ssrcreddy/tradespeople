// Worker mode (design §5, §8): same image as the API, MODE=worker. Consumes
// the queues and runs the stuck-job sweep every five minutes.
import { loadConfig } from "./config.ts";
import { buildRuntime } from "./runtime.ts";
import { Q } from "./queue.ts";
import { captureError, initSentry } from "./observability.ts";
import type { WorkerDeps } from "./jobs/deps.ts";
import { fetchInbound } from "./jobs/fetchInbound.ts";
import { extract } from "./jobs/extract.ts";
import { notify } from "./jobs/notify.ts";
import { stuckSweep } from "./jobs/stuckSweep.ts";
import { sendDocument, sendFailed } from "./jobs/sendDocument.ts";
import { invoiceReminder } from "./jobs/invoiceReminder.ts";
import { expirySweep } from "./jobs/expirySweep.ts";
import { exportBusiness, deleteBusinessJob } from "./jobs/exportDelete.ts";

export async function startWorkers(d: WorkerDeps, log: (msg: string, extra?: object) => void = (m, e) => console.log(JSON.stringify({ msg: m, ...e }))) {
  const wrap = <T extends object>(name: string, fn: (d: WorkerDeps, data: T) => Promise<unknown>) =>
    async ([job]: { id: string; data: T }[]) => {
      const started = Date.now();
      try {
        const r = await fn(d, job!.data);
        log("job.done", { queue: name, jobId: job!.id, ms: Date.now() - started, result: r });
      } catch (err) {
        log("job.failed", { queue: name, jobId: job!.id, error: (err as Error).message });
        captureError(err, { queue: name, jobId: job!.id });
        throw err;   // pg-boss retries with backoff
      }
    };
  await d.boss.work(Q.fetchInbound, { batchSize: 1 }, wrap(Q.fetchInbound, fetchInbound));
  await d.boss.work(Q.extract, { batchSize: 1 }, wrap(Q.extract, extract));
  await d.boss.work(Q.notify, { batchSize: 1 }, wrap(Q.notify, notify));
  await d.boss.work(Q.stuckSweep, { batchSize: 1 }, wrap(Q.stuckSweep, (dd) => stuckSweep(dd)));
  await d.boss.work(Q.sendDocument, { batchSize: 1 }, wrap(Q.sendDocument, sendDocument));
  await d.boss.work(Q.sendFailed, { batchSize: 1 }, wrap(Q.sendFailed, sendFailed));
  await d.boss.work(Q.invoiceReminder, { batchSize: 1 }, wrap(Q.invoiceReminder, invoiceReminder));
  await d.boss.work(Q.expirySweep, { batchSize: 1 }, wrap(Q.expirySweep, (dd) => expirySweep(dd)));
  await d.boss.work(Q.exportBusiness, { batchSize: 1 }, wrap(Q.exportBusiness, exportBusiness));
  await d.boss.work(Q.deleteBusiness, { batchSize: 1 }, wrap(Q.deleteBusiness, deleteBusinessJob));
}

if (process.argv[1]?.endsWith("worker.ts")) {
  const cfg = loadConfig();
  await initSentry(cfg.sentryDsn, "worker");
  const rt = buildRuntime(cfg, "worker");
  rt.boss.on("error", (e) => console.error(JSON.stringify({ msg: "pg-boss error", error: e.message })));
  await rt.boss.start();
  const deps: WorkerDeps = {
    db: rt.db, pool: rt.pool, boss: rt.boss, store: rt.store, inbound: rt.inbound, llm: rt.llm,
    pricing: cfg.pricing, mailer: rt.mailer, push: rt.push, adminDatabaseUrl: cfg.adminDatabaseUrl,
    webOrigin: cfg.webOrigin, llmMonthlyCapUsd: cfg.llmMonthlyCapUsd,
  };
  await startWorkers(deps);
  await rt.boss.schedule(Q.stuckSweep, "*/5 * * * *");
  await rt.boss.schedule(Q.expirySweep, "0 6 * * *");
  console.log(JSON.stringify({ msg: "worker started", llm: rt.llm.model }));

  const shutdown = async () => {
    await rt.boss.stop({ graceful: true, timeout: 30_000 });   // drain in-flight jobs (§8)
    await rt.pool.end();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
