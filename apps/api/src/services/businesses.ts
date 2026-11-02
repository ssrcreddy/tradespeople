import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { TaxComponents, TAX_PRESETS } from "@qa/shared";
import { type Db, withTenant } from "../db/client.ts";
import { businesses, memberships } from "../db/schema.ts";
import { audit } from "./audit.ts";
import { AppError } from "../http/errors.ts";
import type { TenantCtx, UserCtx } from "../http/context.ts";
import type pg from "pg";

const TaxPreset = z.enum(Object.keys(TAX_PRESETS) as [keyof typeof TAX_PRESETS, ...(keyof typeof TAX_PRESETS)[]]);

export const CreateBusiness = z.object({
  name: z.string().trim().min(1).max(120),
  taxPreset: TaxPreset.optional(),
  taxComponents: TaxComponents.optional(),
  timezone: z.string().max(64).optional(),
  replyToEmail: z.email().optional(),
}).refine((b) => !(b.taxPreset && b.taxComponents), "give taxPreset or taxComponents, not both");

export const BusinessSettings = z.object({
  name: z.string().trim().min(1).max(120),
  taxComponents: TaxComponents,
  timezone: z.string().max(64),
  replyToEmail: z.email().nullable(),
  senderAllowlist: z.array(z.email()).max(20),
  termsDays: z.number().int().min(0).max(365),
  quoteExpiryDays: z.number().int().min(1).max(365),
  depositPctDefault: z.number().int().min(0).max(100),
  collapseAssemblies: z.boolean(),
}).partial();

// 20 random bytes, base32-ish lowercase: unguessable, safe in an email local part.
const newIntakeToken = () => randomBytes(20).toString("base64url").replace(/[-_]/g, "").toLowerCase().slice(0, 24);

export async function createBusiness(db: Db, pool: pg.Pool, u: UserCtx, input: z.infer<typeof CreateBusiness>) {
  const existing = await pool.query("select 1 from app_memberships_for_user($1)", [u.userId]);
  if (existing.rowCount) throw new AppError(409, "ALREADY_IN_BUSINESS", "this account already belongs to a business");

  const id = randomUUID();
  const taxComponents = input.taxComponents ?? (input.taxPreset ? TAX_PRESETS[input.taxPreset] : []);
  return withTenant(db, id, async (tx) => {
    const [b] = await tx.insert(businesses).values({
      id, name: input.name, taxComponents, intakeToken: newIntakeToken(),
      ...(input.timezone ? { timezone: input.timezone } : {}),
      replyToEmail: input.replyToEmail ?? u.email,
      senderAllowlist: [u.email],
    }).returning();
    await tx.insert(memberships).values({ userId: u.userId, businessId: id, role: "owner" });
    await audit(tx, id, u.userId, "business", id, "business.created", { name: input.name });
    return b!;
  });
}

export async function getBusiness(db: Db, t: TenantCtx) {
  return withTenant(db, t.businessId, async (tx) => {
    const [b] = await tx.select().from(businesses).where(eq(businesses.id, t.businessId));
    return b!;
  });
}

export async function updateSettings(db: Db, t: TenantCtx, patch: z.infer<typeof BusinessSettings>) {
  if (t.role !== "owner") throw new AppError(403, "OWNER_ONLY", "only the owner can change business settings");
  return withTenant(db, t.businessId, async (tx) => {
    const [b] = await tx.update(businesses).set(patch).where(eq(businesses.id, t.businessId)).returning();
    await audit(tx, t.businessId, t.userId, "business", t.businessId, "settings.updated", patch);
    return b!;
  });
}

export const intakeAddress = (token: string, domain: string) => `quote+${token}@${domain}`;
