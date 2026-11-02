import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { QuotePatch, AddFromPriceBook, PreviewRequest } from "@qa/shared";
import type { Deps } from "../app.ts";
import type { makeGuards } from "../http/context.ts";
import { createQuote, listQuotes, getQuote, patchQuote, addFromPriceBook, preview } from "../services/quotes.ts";

type Guards = ReturnType<typeof makeGuards>;
const IdParam = z.object({ id: z.uuid() });
const CreateQuote = z.object({ customerId: z.uuid(), jobId: z.uuid().optional() });

export const quoteRoutes = ({ db }: Deps, g: Guards): FastifyPluginAsync => async (app) => {
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
};
