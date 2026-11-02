// HTTP mode (design §5, §8). The worker entry point (MODE=worker) arrives with
// the job queue on Days 6–10.
import { loadConfig } from "./config.ts";
import { createDb } from "./db/client.ts";
import { createAuth } from "./auth.ts";
import { buildApp } from "./app.ts";

const cfg = loadConfig();
const { db, pool } = createDb(cfg.databaseUrl);
const auth = createAuth(db, cfg);
const app = await buildApp({ db, pool, auth, cfg }, { logger: true });

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: cfg.port, host: "0.0.0.0" });
