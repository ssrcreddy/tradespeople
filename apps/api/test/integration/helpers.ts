import { inject } from "vitest";
import pg from "pg";
import type { FastifyInstance, InjectOptions } from "fastify";
import { createDb } from "../../src/db/client.ts";
import { createAuth } from "../../src/auth.ts";
import { buildApp } from "../../src/app.ts";
import type { Config } from "../../src/config.ts";
import { createBoss, Q, type QueueName } from "../../src/queue.ts";
import { memoryStore } from "../../src/storage.ts";
import { fakeInbound } from "../../src/inbound.ts";
import { memoryMailer } from "../../src/mail.ts";
import { scriptedProvider, type ModelRequest } from "../../src/llm/gateway.ts";
import type { WorkerDeps } from "../../src/jobs/deps.ts";
import { fetchInbound } from "../../src/jobs/fetchInbound.ts";
import { extract } from "../../src/jobs/extract.ts";
import { notify } from "../../src/jobs/notify.ts";
import { stuckSweep } from "../../src/jobs/stuckSweep.ts";

export const ORIGIN = "http://localhost:3000";

export async function buildTestApp() {
  const cfg: Config = {
    // Normally the non-owner app role, so RLS applies. TEST_BYPASS_RLS=1 connects
    // as the superuser instead (RLS off) to prove the repositories' explicit
    // tenant filters hold on their own — the two layers are tested separately.
    databaseUrl: process.env.TEST_BYPASS_RLS === "1" ? inject("adminUrl") : inject("appUrl"),
    authSecret: "test-secret-test-secret-test-secret-123",
    authUrl: "http://localhost:8080",
    webOrigin: ORIGIN,
    trustedOrigins: [ORIGIN, "http://localhost:8080"],
    intakeDomain: "intake.test",
    intakeRateLimitPerHour: 5,
    port: 0,
    production: false,
    s3: { endpoint: undefined, bucket: "test", accessKeyId: "x", secretAccessKey: "x" },
    resend: undefined,
    openai: undefined,
    pricing: { inputUsdPerMTok: 2.5, outputUsdPerMTok: 10 },
    llmMonthlyCapUsd: 20,
  };
  const { db, pool } = createDb(cfg.databaseUrl);
  // Superuser connection for test setup and inspection only (bypasses RLS).
  const admin = new pg.Pool({ connectionString: inject("adminUrl"), max: 2 });
  const boss = createBoss(cfg.databaseUrl, { worker: false });
  boss.on("error", () => {});
  await boss.start();
  const store = memoryStore();
  const inbound = fakeInbound();
  const mailer = memoryMailer();
  // Tests swap the model's behaviour per case.
  let script: (req: ModelRequest, call: number) => unknown = () => { throw new Error("no LLM script set"); };
  const llm = scriptedProvider((req, call) => script(req, call));

  const app = await buildApp({ db, pool, auth: createAuth(db, cfg), cfg, boss, store, inbound });
  const worker: WorkerDeps = {
    db, pool, boss, store, inbound, llm, pricing: cfg.pricing, mailer, webOrigin: ORIGIN, llmMonthlyCapUsd: cfg.llmMonthlyCapUsd,
  };
  const handlers: Record<QueueName, (d: WorkerDeps, data: any) => Promise<unknown>> = {
    [Q.fetchInbound]: fetchInbound, [Q.extract]: extract, [Q.notify]: notify, [Q.stuckSweep]: (d) => stuckSweep(d),
  };

  // Runs every queued job of the given queues (in order) until none are left —
  // proving the jobs were really enqueued, not just that handlers work.
  async function drain(...queues: QueueName[]) {
    const results: { queue: QueueName; data: any; result: unknown }[] = [];
    for (let round = 0; round < 20; round++) {
      let ran = 0;
      for (const q of queues) {
        const jobs = await boss.fetch<any>(q, { batchSize: 20 });
        for (const j of jobs) {
          const result = await handlers[q](worker, j.data);
          await boss.complete(q, j.id);
          results.push({ queue: q, data: j.data, result });
          ran++;
        }
      }
      if (!ran) break;
    }
    return results;
  }

  return {
    app, db, pool, admin, boss, store, inbound, mailer, llm, worker, drain,
    setScript: (fn: typeof script) => { script = fn; },
    close: async () => { await app.close(); await boss.stop({ graceful: false }); await pool.end(); await admin.end(); },
  };
}

export interface Client {
  cookie: string;
  req: <T = any>(method: InjectOptions["method"], url: string, body?: unknown) => Promise<{ status: number; body: T }>;
}

let seq = 0;
export async function signUp(app: FastifyInstance, label = "user"): Promise<Client & { email: string }> {
  const email = `${label}.${Date.now()}.${++seq}@example.com`;
  const res = await app.inject({
    method: "POST", url: "/api/auth/sign-up/email",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    payload: { email, password: "correct-horse-battery", name: label },
  });
  if (res.statusCode !== 200) throw new Error(`sign-up failed ${res.statusCode}: ${res.body}`);
  const setCookie = res.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie : [setCookie ?? ""]).map((c) => c.split(";")[0]).join("; ");
  return {
    email, cookie,
    req: async (method, url, body) => {
      const r = await app.inject({
        method, url,
        headers: { cookie, origin: ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { payload: body as object } : {}),
      });
      return { status: r.statusCode, body: r.body ? (r.headers["content-type"]?.includes("json") ? JSON.parse(r.body) : r.body) : undefined };
    },
  };
}

export async function signUpWithBusiness(app: FastifyInstance, label: string, taxPreset = "ON-HST") {
  const c = await signUp(app, label);
  const b = await c.req("POST", "/businesses", { name: `${label} Electric`, taxPreset });
  if (b.status !== 201) throw new Error(`create business failed: ${JSON.stringify(b.body)}`);
  return { ...c, business: b.body };
}
