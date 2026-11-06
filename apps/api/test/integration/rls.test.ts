// Raw-SQL isolation suite (design §23): proves RLS on its own, independently of
// the repositories. Connects as the app role, seeds two businesses, and checks
// that every tenant table hides business B from business A.
import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { TENANT_TABLES } from "../../src/db/schema.ts";

let app: pg.Pool;
let admin: pg.Pool;
const A = randomUUID();
const B = randomUUID();

async function asTenant<T>(businessId: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await app.connect();
  try {
    await c.query("BEGIN");
    if (businessId !== null) await c.query("select set_config('app.business_id', $1, true)", [businessId]);
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// One row per tenant table for a business, inserted as the app role under its own tenant.
async function seed(biz: string, label: string) {
  const user = `user_${label}_${biz.slice(0, 8)}`;
  await admin.query(`insert into "user"(id, name, email) values ($1, $2, $3)`, [user, label, `${user}@example.com`]);
  await asTenant(biz, async (c) => {
    await c.query(`insert into businesses(id, name, intake_token) values ($1, $2, $3)`, [biz, `Biz ${label}`, `tok_${biz}`]);
    await c.query(`insert into memberships(user_id, business_id, role) values ($1, $2, 'owner')`, [user, biz]);
    const cust = (await c.query(`insert into customers(business_id, name, email) values ($1, 'C', $2) returning id`, [biz, `c_${label}@example.com`])).rows[0].id;
    const comp = (await c.query(`insert into price_book_items(business_id, kind, name, unit, rate_cents) values ($1, 'material', 'Breaker', 'each', 1000) returning id`, [biz])).rows[0].id;
    const asm = (await c.query(`insert into price_book_items(business_id, kind, name, unit) values ($1, 'assembly', 'EV install', 'each') returning id`, [biz])).rows[0].id;
    await c.query(`insert into assembly_components(business_id, assembly_id, component_id, qty_milli) values ($1, $2, $3, 1000)`, [biz, asm, comp]);
    const inbound = (await c.query(`insert into inbound_messages(business_id, provider_message_id, raw_object_key, from_addr, disposition) values ($1, $2, 'k', 'x@example.com', 'job') returning id`, [biz, `pm_${biz}`])).rows[0].id;
    const job = (await c.query(`insert into jobs(business_id, customer_id, inbound_message_id, source) values ($1, $2, $3, 'paste') returning id`, [biz, cust, inbound])).rows[0].id;
    const quote = (await c.query(`insert into quotes(business_id, job_id, customer_id, number) values ($1, $2, $3, 1) returning id`, [biz, job, cust])).rows[0].id;
    await c.query(`insert into quote_lines(business_id, quote_id, sort, description, qty_milli, unit, unit_price_cents, needs_price) values ($1, $2, 0, 'x', 1000, 'each', 100, false)`, [biz, quote]);
    const inv = (await c.query(`insert into invoices(business_id, quote_id, kind, number, amount_cents, tax_cents, snapshot) values ($1, $2, 'final', 1, 100, 13, '{}') returning id`, [biz, quote])).rows[0].id;
    await c.query(`insert into payments(business_id, invoice_id, amount_cents, method, received_on, recorded_by, idempotency_key) values ($1, $2, 50, 'etransfer', current_date, $3, 'k1')`, [biz, inv, user]);
    await c.query(`insert into audit_events(business_id, actor, entity, entity_id, action) values ($1, 'system', 'quote', $2, 'test')`, [biz, quote]);
    await c.query(`insert into llm_calls(business_id, job_id, purpose, model, prompt_version, input_tokens, output_tokens, cost_usd, latency_ms) values ($1, $2, 'extract', 'm', 'v1', 1, 1, 0.001, 1)`, [biz, job]);
    await c.query(`insert into notifications(business_id, user_id, kind, entity_id, channel) values ($1, $2, 'draft_ready', $3, 'email')`, [biz, user, quote]);
    await c.query(`insert into usage_counters(business_id, month) values ($1, date_trunc('month', current_date))`, [biz]);
    await c.query(`insert into email_events(business_id, document_id, provider_id, type) values ($1, $2, 'p', 'delivered')`, [biz, quote]);
    await c.query(`insert into email_suppressions(business_id, email, reason) values ($1, 'x@example.com', 'bounce')`, [biz]);
    await c.query(`insert into push_subscriptions(business_id, user_id, endpoint, p256dh, auth) values ($1, $2, 'https://push.example/1', 'k', 'a')`, [biz, user]);
  });
}

beforeAll(async () => {
  app = new pg.Pool({ connectionString: inject("appUrl") });
  admin = new pg.Pool({ connectionString: inject("adminUrl") });
  await seed(A, "a");
  await seed(B, "b");
});
afterAll(async () => { await app.end(); await admin.end(); });

describe("RLS — raw SQL as the app role", () => {
  it("the app role is not a superuser and cannot bypass RLS", async () => {
    const r = await app.query("select rolsuper, rolbypassrls from pg_roles where rolname = current_user");
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it.each(["businesses", ...TENANT_TABLES])("%s: tenant A sees only its own rows", async (table) => {
    const col = table === "businesses" ? "id" : "business_id";
    const rows = await asTenant(A, (c) => c.query(`select ${col} as b from ${table}`));
    expect(rows.rowCount).toBeGreaterThan(0);
    expect(new Set(rows.rows.map((r) => r.b))).toEqual(new Set([A]));
  });

  it.each(["businesses", ...TENANT_TABLES])("%s: no tenant setting → error, not data", async (table) => {
    await expect(asTenant(null, (c) => c.query(`select 1 from ${table} limit 1`))).rejects.toThrow(/app\.business_id|invalid input syntax/);
  });

  it("an empty tenant setting (left over on a pooled connection) also errors", async () => {
    await expect(asTenant("", (c) => c.query("select 1 from quotes limit 1"))).rejects.toThrow(/invalid input syntax/);
  });

  it("cannot insert a row for another tenant", async () => {
    await expect(asTenant(A, (c) => c.query(`insert into customers(business_id, name, phone) values ($1, 'evil', '1')`, [B])))
      .rejects.toThrow(/row-level security/);
  });

  it("cannot move a row to another tenant", async () => {
    await expect(asTenant(A, (c) => c.query(`update customers set business_id = $1`, [B]))).rejects.toThrow(/row-level security/);
  });

  it("update and delete of another tenant's rows affect nothing", async () => {
    const r = await asTenant(A, async (c) => {
      const u = await c.query(`update quotes set terms = 'hacked' where business_id = $1`, [B]);
      const d = await c.query(`delete from quote_lines where business_id = $1`, [B]);
      return [u.rowCount, d.rowCount];
    });
    expect(r).toEqual([0, 0]);
    const still = await admin.query(`select count(*)::int as n from quote_lines where business_id = $1`, [B]);
    expect(still.rows[0].n).toBe(1);
  });

  it("audit_events is append-only for the app role", async () => {
    await expect(asTenant(A, (c) => c.query(`update audit_events set action = 'x'`))).rejects.toThrow(/permission denied/);
    await expect(asTenant(A, (c) => c.query(`delete from audit_events`))).rejects.toThrow(/permission denied/);
  });

  it("membership lookup before a tenant is known returns only that user's businesses", async () => {
    const r = await app.query("select business_id from app_memberships_for_user($1)", [`user_a_${A.slice(0, 8)}`]);
    expect(r.rows.map((x) => x.business_id)).toEqual([A]);
  });

  it("intake token lookup returns the id only", async () => {
    const r = await app.query("select app_business_by_intake_token($1) as id", [`tok_${B}`]);
    expect(r.rows[0].id).toBe(B);
  });

  it("the DB rejects a quote whose totals break the identity", async () => {
    await expect(asTenant(A, (c) => c.query(
      `update quotes set subtotal_cents = 1000, discount_cents = 0, tax_cents = 130, total_cents = 1131`))).rejects.toThrow(/quotes_total_identity/);
    await expect(asTenant(A, (c) => c.query(
      `update quotes set subtotal_cents = 1000, discount_cents = 1001, tax_cents = 0, total_cents = -1`))).rejects.toThrow(/quotes_discount_bound/);
  });
});
