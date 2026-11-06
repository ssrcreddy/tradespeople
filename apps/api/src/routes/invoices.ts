import type { FastifyPluginAsync } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Deps } from "../app.ts";
import type { makeGuards } from "../http/context.ts";
import { withTenant } from "../db/client.ts";
import { invoices } from "../db/schema.ts";
import { PaymentInput, getInvoice, listInvoices, recordPayment, sendInvoice, shareInvoice } from "../services/invoices.ts";
import { notFound } from "../http/errors.ts";

type Guards = ReturnType<typeof makeGuards>;
const IdParam = z.object({ id: z.uuid() });

export const invoiceRoutes = ({ db, boss, store }: Deps, g: Guards): FastifyPluginAsync => async (app) => {
  app.addHook("preHandler", g.requireTenant);

  app.get("/invoices", async (req) => listInvoices(db, req.tenant!));
  app.get("/invoices/:id", async (req) => getInvoice(db, req.tenant!, IdParam.parse(req.params).id));
  app.post("/invoices/:id/send", async (req) => sendInvoice(db, boss, req.tenant!, IdParam.parse(req.params).id));
  app.post("/invoices/:id/share", async (req) => shareInvoice(db, boss, store, req.tenant!, IdParam.parse(req.params).id));
  app.post("/invoices/:id/payments", async (req) =>
    recordPayment(db, req.tenant!, IdParam.parse(req.params).id, PaymentInput.parse(req.body)));

  app.get("/invoices/:id/pdf", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const t = req.tenant!;
    const [i] = await withTenant(db, t.businessId, (tx) =>
      tx.select({ key: invoices.pdfObjectKey, number: invoices.number }).from(invoices)
        .where(and(eq(invoices.businessId, t.businessId), eq(invoices.id, id))));
    if (!i?.key) throw notFound("PDF");
    const o = await store.get(i.key);
    return reply.type("application/pdf").header("content-disposition", `attachment; filename="Invoice-${i.number}.pdf"`).send(o.body);
  });
};
