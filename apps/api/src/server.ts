// HTTP mode (design §5, §8). The worker runs from the same code: src/worker.ts.
import { loadConfig } from "./config.ts";
import { buildRuntime } from "./runtime.ts";
import { buildApp } from "./app.ts";

const cfg = loadConfig();
const rt = buildRuntime(cfg, "http");
rt.boss.on("error", (e) => console.error(JSON.stringify({ msg: "pg-boss error", error: e.message })));
await rt.boss.start();
const app = await buildApp(rt, { logger: true });

const shutdown = async () => {
  await app.close();
  await rt.boss.stop({ graceful: false });
  await rt.pool.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: cfg.port, host: "0.0.0.0" });
