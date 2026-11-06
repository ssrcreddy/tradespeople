import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.ts";
import type { makeGuards } from "../http/context.ts";
import { handleDeliveryEvent, handleInboundWebhook, listQuarantine, releaseQuarantined } from "../services/intake.ts";

type Guards = ReturnType<typeof makeGuards>;

// Provider webhook: verified on the raw body, always 200 after durable store (§21).
export const webhookRoutes = ({ db, pool, boss, store, inbound, cfg }: Deps): FastifyPluginAsync => async (app) => {
  // Encapsulated: only this plugin keeps JSON bodies as raw strings.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
  app.post("/webhooks/resend/inbound", { bodyLimit: 512 * 1024 }, async (req) => {
    const outcome = await handleInboundWebhook(
      { db, pool, boss, store, inbound, rateLimitPerHour: cfg.intakeRateLimitPerHour },
      req.body as string, req.headers);
    return { ok: true, outcome };
  });
  // Delivery events for what we sent: bounces and complaints (§12, §21).
  app.post("/webhooks/resend/events", { bodyLimit: 512 * 1024 }, async (req) => {
    const outcome = await handleDeliveryEvent({ db, pool, boss, inbound }, req.body as string, req.headers);
    return { ok: true, outcome };
  });
};

export const inboxRoutes = ({ db, boss }: Deps, g: Guards): FastifyPluginAsync => async (app) => {
  app.addHook("preHandler", g.requireTenant);
  app.get("/inbox/quarantine", async (req) => listQuarantine(db, req.tenant!));
  app.post("/inbox/quarantine/:id/release", async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { allowSender } = z.object({ allowSender: z.boolean().default(false) }).parse(req.body ?? {});
    return releaseQuarantined(db, boss, req.tenant!, id, allowSender);
  });
};
