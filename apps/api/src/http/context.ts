// Resolves who is calling and which business they act for. The tenant always
// comes from the session — never from a client-supplied id (design §9, §21).
import type { FastifyReply, FastifyRequest } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import type pg from "pg";
import type { Auth } from "../auth.ts";
import { AppError } from "./errors.ts";

export interface UserCtx { userId: string; email: string }
export interface TenantCtx extends UserCtx { businessId: string; role: "owner" | "member" }

declare module "fastify" {
  interface FastifyRequest {
    user?: UserCtx;
    tenant?: TenantCtx;
  }
}

export function makeGuards(auth: Auth, pool: pg.Pool) {
  async function requireUser(req: FastifyRequest, _reply: FastifyReply) {
    const s = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!s) throw new AppError(401, "UNAUTHENTICATED", "sign in required");
    req.user = { userId: s.user.id, email: s.user.email };
  }

  async function requireTenant(req: FastifyRequest, reply: FastifyReply) {
    await requireUser(req, reply);
    const { rows } = await pool.query<{ business_id: string; role: "owner" | "member" }>(
      "select business_id, role from app_memberships_for_user($1)", [req.user!.userId]);
    const m = rows[0];   // MVP: one business per user
    if (!m) throw new AppError(403, "NO_BUSINESS", "create a business first");
    req.tenant = { ...req.user!, businessId: m.business_id, role: m.role };
  }

  return { requireUser, requireTenant };
}

// The value used on audit rows and approved_by.
export const actorOf = (t: UserCtx) => t.userId;
