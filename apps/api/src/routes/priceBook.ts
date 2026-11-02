import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.ts";
import type { makeGuards } from "../http/context.ts";
import { ItemInput, ItemPatch, createItem, updateItem, deactivateItem, listItems, loadStarter } from "../services/priceBook.ts";

type Guards = ReturnType<typeof makeGuards>;
const IdParam = z.object({ id: z.uuid() });

export const priceBookRoutes = ({ db }: Deps, g: Guards): FastifyPluginAsync => async (app) => {
  app.addHook("preHandler", g.requireTenant);

  app.get("/price-book", async (req) => {
    const q = z.object({ includeInactive: z.enum(["true", "false"]).optional() }).parse(req.query);
    return listItems(db, req.tenant!, { includeInactive: q.includeInactive === "true" });
  });

  app.post("/price-book", async (req, reply) =>
    reply.code(201).send(await createItem(db, req.tenant!, ItemInput.parse(req.body))));

  app.post("/price-book/starter", async (req, reply) =>
    reply.code(201).send(await loadStarter(db, req.tenant!)));

  app.patch("/price-book/:id", async (req) =>
    updateItem(db, req.tenant!, IdParam.parse(req.params).id, ItemPatch.parse(req.body)));

  app.delete("/price-book/:id", async (req, reply) => {
    await deactivateItem(db, req.tenant!, IdParam.parse(req.params).id);
    return reply.code(204).send();
  });
};
