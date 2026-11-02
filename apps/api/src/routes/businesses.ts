import type { FastifyPluginAsync } from "fastify";
import type { Deps } from "../app.ts";
import type { makeGuards } from "../http/context.ts";
import { CreateBusiness, BusinessSettings, createBusiness, getBusiness, updateSettings, intakeAddress } from "../services/businesses.ts";
import type { businesses } from "../db/schema.ts";

type Guards = ReturnType<typeof makeGuards>;

const view = (b: typeof businesses.$inferSelect, domain: string) => {
  const { intakeToken, nextQuoteNo, nextInvoiceNo, ...rest } = b;
  return { ...rest, intakeAddress: intakeAddress(intakeToken, domain) };
};

export const businessRoutes = ({ db, pool, cfg }: Deps, g: Guards): FastifyPluginAsync => async (app) => {
  // Onboarding entry: a signed-in user with no business creates one and becomes its owner.
  app.post("/businesses", { preHandler: g.requireUser }, async (req, reply) => {
    const b = await createBusiness(db, pool, req.user!, CreateBusiness.parse(req.body));
    return reply.code(201).send(view(b, cfg.intakeDomain));
  });

  app.get("/settings/business", { preHandler: g.requireTenant }, async (req) =>
    view(await getBusiness(db, req.tenant!), cfg.intakeDomain));

  app.patch("/settings/business", { preHandler: g.requireTenant }, async (req) =>
    view(await updateSettings(db, req.tenant!, BusinessSettings.parse(req.body)), cfg.intakeDomain));
};
