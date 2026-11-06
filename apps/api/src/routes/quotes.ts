import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { QuotePatch, AddFromPriceBook, PreviewRequest } from "@qa/shared";
import type { Deps } from "../app.ts";
import type { makeGuards } from "../http/context.ts";
import { createQuote, listQuotes, getQuote, patchQuote, addFromPriceBook, preview, quoteOf } from "../services/quotes.ts";
import { ApproveInput, OutcomeInput, approve, outcome, revise, send, share } from "../services/quoteActions.ts";
import { ConvertInput, convert, invoicesForQuote } from "../services/invoices.ts";
import { withTenant } from "../db/client.ts";
import { quotes } from "../db/schema.ts";
import { notFound } from "../http/errors.ts";

type Guards = ReturnType<typeof makeGuards>;
const IdParam = z.object({ id: z.uuid() });
const CreateQuote = z.object({ customerId: z.uuid(), jobId: z.uuid().optional() });

export const quoteRoutes = ({ db, boss, store }: Deps, g: Guards): FastifyPluginAsync => async (app) => {
  app.addHook("preHandler", g.requireTenant);

  app.get("/quotes", async (req) => listQuotes(db, req.tenant!));

  app.post("/quotes", async (req, reply) =>
    reply.code(201).send(await createQuote(db, req.tenant!, CreateQuote.parse(req.body))));

  app.get("/quotes/:id", async (req) => getQuote(db, req.tenant!, IdParam.parse(req.params).id));

  app.patch("/quotes/:id", async (req) =>
    patchQuote(db, req.tenant!, IdParam.parse(req.params).id, QuotePatch.parse(req.body)));

  app.post("/quotes/:id/lines/from-price-book", async (req) =>
    addFromPriceBook(db, req.tenant!, IdParam.parse(req.params).id, AddFromPriceBook.parse(req.body)));

  // Live totals for unsaved edits in the review screen; writes nothing (§21).
  app.post("/quotes/:id/preview-totals", async (req) =>
    preview(db, req.tenant!, IdParam.parse(req.params).id, PreviewRequest.parse(req.body)));

  app.post("/quotes/:id/approve", async (req) =>
    approve(db, req.tenant!, IdParam.parse(req.params).id, ApproveInput.parse(req.body)));
  app.post("/quotes/:id/send", async (req) => send(db, boss, req.tenant!, IdParam.parse(req.params).id));
  app.post("/quotes/:id/share", async (req) => share(db, store, req.tenant!, IdParam.parse(req.params).id));
  app.post("/quotes/:id/outcome", async (req) =>
    outcome(db, req.tenant!, IdParam.parse(req.params).id, OutcomeInput.parse(req.body)));
  app.post("/quotes/:id/revise", async (req, reply) =>
    reply.code(201).send(await revise(db, req.tenant!, IdParam.parse(req.params).id)));
  app.post("/quotes/:id/convert", async (req) =>
    convert(db, req.tenant!, IdParam.parse(req.params).id, ConvertInput.parse(req.body ?? {})));
  app.get("/quotes/:id/invoices", async (req) => invoicesForQuote(db, req.tenant!, IdParam.parse(req.params).id));

  app.get("/quotes/:id/pdf", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const t = req.tenant!;
    const [q] = await withTenant(db, t.businessId, (tx) =>
      tx.select({ key: quotes.pdfObjectKey, number: quotes.number, version: quotes.version }).from(quotes).where(quoteOf(t.businessId, id)));
    if (!q?.key) throw notFound("PDF");
    const o = await store.get(q.key);
    return reply.type("application/pdf")
      .header("content-disposition", `attachment; filename="Quote-${q.number}-v${q.version}.pdf"`).send(o.body);
  });
};
