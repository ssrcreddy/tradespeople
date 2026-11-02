import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Deps } from "../app.ts";
import type { makeGuards } from "../http/context.ts";
import { withTenant } from "../db/client.ts";
import { customers } from "../db/schema.ts";
import { audit } from "../services/audit.ts";
import { AppError, notFound } from "../http/errors.ts";

type Guards = ReturnType<typeof makeGuards>;
const IdParam = z.object({ id: z.uuid() });

const CustomerInput = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.email().nullable().default(null),
  phone: z.string().trim().min(3).max(40).nullable().default(null),
  siteAddress: z.string().trim().max(400).nullable().default(null),
});
const CustomerPatch = CustomerInput.partial();

// Explicit tenant filter on every query (§11) — RLS is the second layer, not the only one.
const customerOf = (businessId: string, id: string) => and(eq(customers.businessId, businessId), eq(customers.id, id));

const requireContact = (c: { email?: string | null; phone?: string | null }) => {
  if (!c.email && !c.phone) throw new AppError(422, "NO_CUSTOMER_CONTACT", "a customer needs an email or a phone number");
};

export const customerRoutes = ({ db }: Deps, g: Guards): FastifyPluginAsync => async (app) => {
  app.addHook("preHandler", g.requireTenant);

  app.get("/customers", async (req) =>
    withTenant(db, req.tenant!.businessId, (tx) =>
      tx.select().from(customers).where(eq(customers.businessId, req.tenant!.businessId)).orderBy(asc(customers.name))));

  app.post("/customers", async (req, reply) => {
    const input = CustomerInput.parse(req.body);
    requireContact(input);
    const t = req.tenant!;
    const c = await withTenant(db, t.businessId, async (tx) => {
      const [row] = await tx.insert(customers).values({ ...input, businessId: t.businessId }).returning();
      await audit(tx, t.businessId, t.userId, "customer", row!.id, "customer.created");
      return row!;
    });
    return reply.code(201).send(c);
  });

  app.get("/customers/:id", async (req) => {
    const { id } = IdParam.parse(req.params);
    const [c] = await withTenant(db, req.tenant!.businessId, (tx) =>
      tx.select().from(customers).where(customerOf(req.tenant!.businessId, id)));
    if (!c) throw notFound("customer");
    return c;
  });

  app.patch("/customers/:id", async (req) => {
    const { id } = IdParam.parse(req.params);
    const patch = CustomerPatch.parse(req.body);
    const t = req.tenant!;
    return withTenant(db, t.businessId, async (tx) => {
      const [cur] = await tx.select().from(customers).where(customerOf(t.businessId, id)).for("update");
      if (!cur) throw notFound("customer");
      requireContact({ ...cur, ...patch });
      const [row] = await tx.update(customers).set(patch).where(customerOf(t.businessId, id)).returning();
      await audit(tx, t.businessId, t.userId, "customer", id, "customer.updated", patch);
      return row!;
    });
  });
};
