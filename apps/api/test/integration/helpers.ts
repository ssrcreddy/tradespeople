import { inject } from "vitest";
import type { FastifyInstance, InjectOptions } from "fastify";
import { createDb } from "../../src/db/client.ts";
import { createAuth } from "../../src/auth.ts";
import { buildApp } from "../../src/app.ts";
import type { Config } from "../../src/config.ts";

export const ORIGIN = "http://localhost:3000";

export async function buildTestApp() {
  const cfg: Config = {
    // Normally the non-owner app role, so RLS applies. TEST_BYPASS_RLS=1 connects
    // as the superuser instead (RLS off) to prove the repositories' explicit
    // tenant filters hold on their own — the two layers are tested separately.
    databaseUrl: process.env.TEST_BYPASS_RLS === "1" ? inject("adminUrl") : inject("appUrl"),
    authSecret: "test-secret-test-secret-test-secret-123",
    authUrl: "http://localhost:8080",
    trustedOrigins: [ORIGIN, "http://localhost:8080"],
    intakeDomain: "intake.test",
    port: 0,
    production: false,
  };
  const { db, pool } = createDb(cfg.databaseUrl);
  const app = await buildApp({ db, pool, auth: createAuth(db, cfg), cfg });
  return { app, close: async () => { await app.close(); await pool.end(); } };
}

export interface Client {
  cookie: string;
  req: <T = any>(method: InjectOptions["method"], url: string, body?: unknown) => Promise<{ status: number; body: T }>;
}

let seq = 0;
export async function signUp(app: FastifyInstance, label = "user"): Promise<Client> {
  const email = `${label}.${Date.now()}.${++seq}@example.com`;
  const res = await app.inject({
    method: "POST", url: "/api/auth/sign-up/email",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    payload: { email, password: "correct-horse-battery", name: label },
  });
  if (res.statusCode !== 200) throw new Error(`sign-up failed ${res.statusCode}: ${res.body}`);
  const setCookie = res.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie : [setCookie ?? ""]).map((c) => c.split(";")[0]).join("; ");
  const client: Client = {
    cookie,
    req: async (method, url, body) => {
      const r = await app.inject({
        method, url,
        headers: { cookie, origin: ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { payload: body as object } : {}),
      });
      return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : undefined };
    },
  };
  return client;
}

export async function signUpWithBusiness(app: FastifyInstance, label: string, taxPreset = "ON-HST") {
  const c = await signUp(app, label);
  const b = await c.req("POST", "/businesses", { name: `${label} Electric`, taxPreset });
  if (b.status !== 201) throw new Error(`create business failed: ${JSON.stringify(b.body)}`);
  return { ...c, business: b.body };
}
