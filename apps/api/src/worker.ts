// Worker mode (design §5, §8): same image as the API, MODE=worker. Consumes
// the queues and runs the stuck-job sweep every five minutes.
import { loadConfig } from "./config.ts";
import { buildRuntime } from "./runtime.ts";
import { Q } from "./queue.ts";
import type { WorkerDeps } from "./jobs/deps.ts";
import { fetchInbound } from "./jobs/fetchInbound.ts";
import { extract } from "./jobs/extract.ts";
import { notify } from "./jobs/notify.ts";
import { stuckSweep } from "./jobs/stuckSweep.ts";

export async function startWorkers(d: WorkerDeps, log: (msg: string, extra?: object) => void = (m, e) => console.log(JSON.stringify({ msg: m, ...e }))) {
  const wrap = <T extends object>(name: string, fn: (d: WorkerDeps, data: T) => Promise<unknown>) =>
    async ([job]: { id: string; data: T }[]) => {
      const started = Date.now();
      try {
        const r = await fn(d, job!.data);
        log("job.done", { queue: name, jobId: job!.id, ms: Date.now() - started, result: r });
      } catch (err) {
        log("job.failed", { queue: name, jobId: job!.id, error: (err as Error).message });
        throw err;   // pg-boss retries with backoff
      }
    };
  await d.boss.work(Q.fetchInbound, { batchSize: 1 }, wrap(Q.fetchInbound, fetchInbound));
  await d.boss.work(Q.extract, { batchSize: 1 }, wrap(Q.extract, extract));
  await d.boss.work(Q.notify, { batchSize: 1 }, wrap(Q.notify, notify));
  await d.boss.work(Q.stuckSweep, { batchSize: 1 }, wrap(Q.stuckSweep, (dd) => stuckSweep(dd)));
}

if (process.argv[1]?.endsWith("worker.ts")) {
  const cfg = loadConfig();
  const rt = buildRuntime(cfg, "worker");
  rt.boss.on("error", (e) => console.error(JSON.stringify({ msg: "pg-boss error", error: e.message })));
  await rt.boss.start();
  const deps: WorkerDeps = {
    db: rt.db, pool: rt.pool, boss: rt.boss, store: rt.store, inbound: rt.inbound, llm: rt.llm,
    pricing: cfg.pricing, mailer: rt.mailer, webOrigin: cfg.webOrigin, llmMonthlyCapUsd: cfg.llmMonthlyCapUsd,
  };
  await startWorkers(deps);
  await rt.boss.schedule(Q.stuckSweep, "*/5 * * * *");
  console.log(JSON.stringify({ msg: "worker started", llm: rt.llm.model }));

  const shutdown = async () => {
    await rt.boss.stop({ graceful: true, timeout: 30_000 });   // drain in-flight jobs (§8)
    await rt.pool.end();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
