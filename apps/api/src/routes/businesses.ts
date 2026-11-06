import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.ts";
import type { makeGuards } from "../http/context.ts";
import { CreateBusiness, BusinessSettings, createBusiness, getBusiness, updateSettings, intakeAddress, rotateIntakeToken } from "../services/businesses.ts";
import { DeleteInput, requestDeletion, requestExport } from "../services/exportDelete.ts";
import { pushSubscriptions } from "../db/schema.ts";
import { withTenant } from "../db/client.ts";
import { audit } from "../services/audit.ts";
import { notFound } from "../http/errors.ts";
import type { businesses } from "../db/schema.ts";

type Guards = ReturnType<typeof makeGuards>;

const view = (b: typeof businesses.$inferSelect, domain: string) => {
  const { intakeToken, nextQuoteNo, nextInvoiceNo, lastExportKey, deletionRequestedAt: _d, ...rest } = b;
  return { ...rest, intakeAddress: intakeAddress(intakeToken, domain), exportAvailable: lastExportKey !== null };
};

const PushInput = z.object({ endpoint: z.url(), keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }) });

export const businessRoutes = ({ db, pool, cfg, boss, store, push }: Deps, g: Guards): FastifyPluginAsync => async (app) => {
  // Onboarding entry: a signed-in user with no business creates one and becomes its owner.
  app.post("/businesses", { preHandler: g.requireUser }, async (req, reply) => {
    const b = await createBusiness(db, pool, req.user!, CreateBusiness.parse(req.body));
    return reply.code(201).send(view(b, cfg.intakeDomain));
  });

  app.get("/settings/business", { preHandler: g.requireTenant }, async (req) =>
    view(await getBusiness(db, req.tenant!), cfg.intakeDomain));

  app.patch("/settings/business", { preHandler: g.requireTenant }, async (req) =>
    view(await updateSettings(db, req.tenant!, BusinessSettings.parse(req.body)), cfg.intakeDomain));

  app.post("/settings/rotate-intake", { preHandler: g.requireTenant }, async (req) =>
    view(await rotateIntakeToken(db, req.tenant!), cfg.intakeDomain));

  app.post("/settings/export", { preHandler: g.requireTenant }, async (req) => requestExport(db, boss, req.tenant!));

  app.get("/settings/export/latest", { preHandler: g.requireTenant }, async (req, reply) => {
    const b = await getBusiness(db, req.tenant!);
    if (!b.lastExportKey) throw notFound("export");
    const o = await store.get(b.lastExportKey);
    return reply.type("application/zip").header("content-disposition", 'attachment; filename="quotes-export.zip"').send(o.body);
  });

  app.delete("/settings/business", { preHandler: g.requireTenant }, async (req) =>
    requestDeletion(db, boss, req.tenant!, DeleteInput.parse(req.body)));

  app.get("/push/public-key", { preHandler: g.requireTenant }, async () => ({ publicKey: push.publicKey }));

  app.post("/push/subscribe", { preHandler: g.requireTenant }, async (req, reply) => {
    const s = PushInput.parse(req.body);
    const t = req.tenant!;
    await withTenant(db, t.businessId, async (tx) => {
      await tx.insert(pushSubscriptions)
        .values({ businessId: t.businessId, userId: t.userId, endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth })
        .onConflictDoNothing();
      await audit(tx, t.businessId, t.userId, "push_subscription", t.userId, "push.subscribed");
    });
    return reply.code(201).send({ ok: true });
  });
};
