import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import type { Db } from "./db/client.ts";
import type { Auth } from "./auth.ts";
import type { Config } from "./config.ts";
import { registerErrorHandler, AppError } from "./http/errors.ts";
import { makeGuards } from "./http/context.ts";
import { businessRoutes } from "./routes/businesses.ts";
import { priceBookRoutes } from "./routes/priceBook.ts";
import { customerRoutes } from "./routes/customers.ts";
import { quoteRoutes } from "./routes/quotes.ts";

export interface Deps { db: Db; pool: pg.Pool; auth: Auth; cfg: Config }

export async function buildApp(deps: Deps, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1024 * 1024 });
  registerErrorHandler(app);

  // CSRF: cookie-authenticated state changes must come from a trusted origin.
  // Better Auth applies its own origin check to /api/auth/*.
  app.addHook("onRequest", async (req) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method) || req.url.startsWith("/api/auth/")) return;
    if (!req.headers.cookie) return;
    const origin = req.headers.origin;
    if (!origin || !deps.cfg.trustedOrigins.includes(origin)) {
      throw new AppError(403, "BAD_ORIGIN", "cross-site request refused");
    }
  });

  // Better Auth handler, bridged from Fastify to a Web Request.
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    handler: async (req, reply) => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      const res = await deps.auth.handler(new Request(new URL(req.url, deps.cfg.authUrl), {
        method: req.method, headers,
        body: req.method === "POST" && req.body !== undefined ? JSON.stringify(req.body) : undefined,
      }));
      reply.status(res.status);
      for (const c of res.headers.getSetCookie()) reply.header("set-cookie", c);
      res.headers.forEach((v, k) => { if (k !== "set-cookie") reply.header(k, v); });
      return reply.send(await res.text());
    },
  });

  app.get("/health", async () => {
    await deps.pool.query("select 1");
    return { ok: true };
  });

  const guards = makeGuards(deps.auth, deps.pool);
  await app.register(businessRoutes(deps, guards));
  await app.register(priceBookRoutes(deps, guards));
  await app.register(customerRoutes(deps, guards));
  await app.register(quoteRoutes(deps, guards));
  return app;
}
