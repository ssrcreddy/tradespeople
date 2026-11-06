// Days 16–21: sign-in by link, password reset, export, deletion, push, token rotation.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { buildTestApp, signUp, signUpWithBusiness, ORIGIN } from "./helpers.ts";
import { Q } from "../../src/queue.ts";
import { deleteBusiness } from "../../src/services/exportDelete.ts";

type T = Awaited<ReturnType<typeof buildTestApp>>;
let t: T;

beforeAll(async () => { t = await buildTestApp(); });
afterAll(async () => { await t.close(); });
beforeEach(async () => {
  for (const q of Object.values(Q)) await t.boss.deleteAllJobs(q);
  t.mailer.sent.length = 0;
});

const post = (url: string, payload: object) => t.app.inject({
  method: "POST", url, payload, headers: { origin: ORIGIN, "content-type": "application/json" },
});
const linkIn = (text: string) => /https?:\/\/\S+/.exec(text)![0];
const pathOf = (u: string) => { const x = new URL(u); return x.pathname + x.search; };
const mailTo = (to: string) => vi.waitFor(() => {
  const m = t.mailer.sent.find((x) => x.to === to);
  if (!m) throw new Error("no mail yet");
  return m;
});

describe("sign-in without a password", () => {
  it("a magic link signs an existing user in, once", async () => {
    const c = await signUp(t.app, "magic");
    expect((await post("/api/auth/sign-in/magic-link", { email: c.email })).statusCode).toBe(200);
    const m = await mailTo(c.email);
    expect(m.subject).toBe("Your sign-in link");
    const url = pathOf(linkIn(m.text));
    const first = await t.app.inject({ method: "GET", url });
    const cookie = [first.headers["set-cookie"]].flat().map((x) => String(x).split(";")[0]).join("; ");
    expect(cookie).toContain("session_token");
    const who = await t.app.inject({ method: "GET", url: "/api/auth/get-session", headers: { cookie } });
    expect(JSON.parse(who.body).user.email).toBe(c.email);
    const again = await t.app.inject({ method: "GET", url });
    expect(String([again.headers["set-cookie"]].flat())).not.toContain("session_token=");
  });

  it("a password reset changes the password", async () => {
    const c = await signUp(t.app, "reset");
    await post("/api/auth/request-password-reset", { email: c.email, redirectTo: "/reset-password" });
    const m = await mailTo(c.email);
    expect(m.subject).toBe("Reset your password");
    const token = /\/reset-password\/([^?\s]+)/.exec(m.text)![1]!;
    expect((await post("/api/auth/reset-password", { newPassword: "a-brand-new-password", token })).statusCode).toBe(200);
    expect((await post("/api/auth/sign-in/email", { email: c.email, password: "correct-horse-battery" })).statusCode).toBe(401);
    expect((await post("/api/auth/sign-in/email", { email: c.email, password: "a-brand-new-password" })).statusCode).toBe(200);
  });

  it("asking for a reset doesn't reveal whether an address has an account", async () => {
    const r = await post("/api/auth/request-password-reset", { email: "nobody-here@example.com", redirectTo: "/reset-password" });
    expect(r.statusCode).toBe(200);
  });
});

describe("email verification when a mail provider is configured", () => {
  it("signing up sends a link and gives no session until it's used", async () => {
    const v = await buildTestApp({ requireEmailVerification: true });
    try {
      const email = `verify.${Date.now()}@example.com`;
      const r = await v.app.inject({
        method: "POST", url: "/api/auth/sign-up/email", payload: { email, password: "correct-horse-battery", name: "V" },
        headers: { origin: ORIGIN, "content-type": "application/json" },
      });
      expect(r.statusCode).toBe(200);
      expect(String([r.headers["set-cookie"]].flat())).not.toContain("session_token=");
      const blocked = await v.app.inject({
        method: "POST", url: "/api/auth/sign-in/email", payload: { email, password: "correct-horse-battery" },
        headers: { origin: ORIGIN, "content-type": "application/json" },
      });
      expect(blocked.statusCode).toBe(403);
      const m = await vi.waitFor(() => { const x = v.mailer.sent.find((y) => y.to === email); if (!x) throw new Error("no mail"); return x; });
      await v.app.inject({ method: "GET", url: pathOf(linkIn(m.text)) });
      const ok = await v.app.inject({
        method: "POST", url: "/api/auth/sign-in/email", payload: { email, password: "correct-horse-battery" },
        headers: { origin: ORIGIN, "content-type": "application/json" },
      });
      expect(ok.statusCode).toBe(200);
    } finally { await v.close(); }
  });
});

describe("export", () => {
  it("bundles CSVs and every stored PDF, and tells the owner", async () => {
    const o = await signUpWithBusiness(t.app, "exporter");
    const c = (await o.req("POST", "/customers", { name: 'Evil =HYPERLINK("x")', email: "e@example.com" })).body;
    let q = (await o.req("POST", "/quotes", { customerId: c.id })).body;
    q = (await o.req("PATCH", `/quotes/${q.id}`, { lockVersion: 0, lines: [{ description: "Work", qty: "1", unit: "each", unitPriceCents: 1000 }] })).body;
    q = (await o.req("POST", `/quotes/${q.id}/approve`, { lockVersion: q.lockVersion })).body;
    await o.req("POST", `/quotes/${q.id}/share`);

    expect((await o.req("GET", "/settings/export/latest")).status).toBe(404);
    await o.req("POST", "/settings/export");
    await t.drain(Q.exportBusiness, Q.notify);
    expect(t.mailer.sent.map((m) => m.subject)).toContain("Your data export is ready");

    const r = await t.app.inject({ method: "GET", url: "/settings/export/latest", headers: { cookie: o.cookie } });
    expect(r.headers["content-disposition"]).toMatch(/^attachment/);
    const zip = unzipSync(new Uint8Array(r.rawPayload));
    expect(Object.keys(zip)).toEqual(expect.arrayContaining(["customers.csv", "quotes.csv", "invoices.csv", "payments.csv", "price_book.csv", "jobs.csv"]));
    expect(Object.keys(zip).some((k) => k.startsWith("documents/quote-Q-0001"))).toBe(true);
    expect(strFromU8(zip["customers.csv"]!)).toContain("e@example.com");
    expect((await o.req("GET", "/settings/business")).body).toMatchObject({ exportAvailable: true });
    expect(JSON.stringify((await o.req("GET", "/settings/business")).body)).not.toContain("exports/");
  });

  it("escapes spreadsheet formulas in exported text", async () => {
    const o = await signUpWithBusiness(t.app, "formula");
    await o.req("POST", "/customers", { name: "=2+5", phone: "5550100" });
    await o.req("POST", "/settings/export");
    await t.drain(Q.exportBusiness);
    const r = await t.app.inject({ method: "GET", url: "/settings/export/latest", headers: { cookie: o.cookie } });
    expect(strFromU8(unzipSync(new Uint8Array(r.rawPayload))["customers.csv"]!)).toContain("'=2+5");
  });

  it("another business can't reach it", async () => {
    const o = await signUpWithBusiness(t.app, "exp-a");
    await o.req("POST", "/settings/export");
    await t.drain(Q.exportBusiness);
    const b = await signUpWithBusiness(t.app, "exp-b");
    expect((await b.req("GET", "/settings/export/latest")).status).toBe(404);
  });
});

describe("deleting a business", () => {
  async function seeded(label: string) {
    const o = await signUpWithBusiness(t.app, label);
    const c = (await o.req("POST", "/customers", { name: "C", email: "c@example.com" })).body;
    const part = (await o.req("POST", "/price-book", { kind: "material", name: "Part", unit: "each", rateCents: 100 })).body;
    await o.req("POST", "/price-book", { kind: "assembly", name: "Asm", unit: "each", components: [{ componentId: part.id, qty: "1" }] });
    let q = (await o.req("POST", "/quotes", { customerId: c.id })).body;
    q = (await o.req("PATCH", `/quotes/${q.id}`, { lockVersion: 0, lines: [{ description: "Work", qty: "1", unit: "each", unitPriceCents: 1000 }] })).body;
    q = (await o.req("POST", `/quotes/${q.id}/approve`, { lockVersion: q.lockVersion })).body;
    await o.req("POST", `/quotes/${q.id}/send`);
    await t.drain(Q.sendDocument);
    await o.req("POST", `/quotes/${q.id}/outcome`, { outcome: "accepted" });
    const inv = (await o.req("POST", `/quotes/${q.id}/convert`, {})).body;
    await o.req("POST", `/invoices/${inv.id}/send`);
    await t.drain(Q.sendDocument);
    await o.req("POST", `/invoices/${inv.id}/payments`, { amountCents: 100, method: "cash", receivedOn: "2026-11-05", idempotencyKey: "pay-12345" });
    await o.req("POST", "/jobs", { text: "a job" });
    return o;
  }

  it("needs the exact name and an export or an explicit waiver", async () => {
    const o = await signUpWithBusiness(t.app, "careful");
    const name = o.business.name;
    expect((await o.req("DELETE", "/settings/business", { confirmName: "wrong" })).body.error.code).toBe("CONFIRM_NAME");
    expect((await o.req("DELETE", "/settings/business", { confirmName: name })).body.error.code).toBe("EXPORT_REQUIRED");
    await o.req("POST", "/settings/export");
    await t.drain(Q.exportBusiness);
    expect((await o.req("DELETE", "/settings/business", { confirmName: name })).status).toBe(200);
  });

  it("removes every row and file of that business, and nothing of anyone else's", async () => {
    const o = await seeded("gone");
    const keep = await seeded("kept");
    const id = o.business.id;
    expect(t.store.keys().some((k) => k.startsWith(`${id}/`))).toBe(true);

    await o.req("DELETE", "/settings/business", { confirmName: o.business.name, exportWaived: true });
    const ran = await t.drain(Q.deleteBusiness);
    expect(ran[0]!.result).toMatchObject({ result: "deleted" });

    const { rows: tables } = await t.admin.query(`
      select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'business_id'`);
    expect(tables.length).toBeGreaterThanOrEqual(16);
    for (const { table_name } of tables) {
      const n = (await t.admin.query(`select count(*)::int as n from "${table_name}" where business_id = $1`, [id])).rows[0].n;
      expect(n, table_name).toBe(0);
    }
    expect((await t.admin.query("select count(*)::int as n from businesses where id = $1", [id])).rows[0].n).toBe(0);
    expect((await t.admin.query(`select count(*)::int as n from "user" where email = $1`, [o.email])).rows[0].n).toBe(0);
    expect(t.store.keys().filter((k) => k.startsWith(`${id}/`))).toEqual([]);
    expect((await o.req("GET", "/quotes")).status).toBe(401);

    expect(t.store.keys().some((k) => k.startsWith(`${keep.business.id}/`))).toBe(true);
    expect((await keep.req("GET", "/quotes")).body).toHaveLength(1);
  });

  it("the job refuses to delete a business nobody asked to delete", async () => {
    const o = await signUpWithBusiness(t.app, "safe");
    expect(await deleteBusiness(t.worker.adminDatabaseUrl!, t.store, o.business.id)).toEqual({ result: "skipped" });
    expect((await o.req("GET", "/settings/business")).status).toBe(200);
  });

  it("only the owner can export or delete", async () => {
    const o = await signUpWithBusiness(t.app, "roles");
    await t.admin.query("update memberships set role = 'member' where business_id = $1", [o.business.id]);
    expect((await o.req("POST", "/settings/export")).body.error.code).toBe("OWNER_ONLY");
    expect((await o.req("DELETE", "/settings/business", { confirmName: o.business.name, exportWaived: true })).body.error.code).toBe("OWNER_ONLY");
  });
});

describe("push notifications", () => {
  const sub = { endpoint: "https://push.example/abc", keys: { p256dh: "key", auth: "auth" } };

  it("reaches subscribed devices along with the email, and forgets dead endpoints", async () => {
    const o = await signUpWithBusiness(t.app, "pusher");
    expect((await o.req("GET", "/push/public-key")).body.publicKey).toBeTruthy();
    expect((await o.req("POST", "/push/subscribe", sub)).status).toBe(201);
    expect((await o.req("POST", "/push/subscribe", sub)).status).toBe(201);   // same device again

    t.setScript(() => ({
      isEnquiry: true, customer: { name: null, email: null, phone: null, siteAddress: null }, jobType: "x", summary: "x", urgency: "unknown",
      lines: [], questions: ["Which room?"],
    }));
    await o.req("POST", "/jobs", { text: "something is wrong with the lights" });
    await t.drain(Q.extract, Q.notify);
    expect(t.push.sent).toHaveLength(1);
    expect(t.push.sent[0]!.msg.title).toBe("A new enquiry needs more information");
    expect(t.push.sent[0]!.msg.url).toContain("/jobs/");
    expect(t.mailer.sent).toHaveLength(1);

    t.push.gone.add(sub.endpoint);
    await o.req("POST", "/jobs", { text: "the other lights are wrong too" });
    await t.drain(Q.extract, Q.notify);
    const { rows } = await t.admin.query("select count(*)::int as n from push_subscriptions where business_id = $1", [o.business.id]);
    expect(rows[0].n).toBe(0);
  });

  it("rejects a malformed subscription", async () => {
    const o = await signUpWithBusiness(t.app, "badpush");
    expect((await o.req("POST", "/push/subscribe", { endpoint: "not a url", keys: {} })).status).toBe(400);
  });
});

describe("intake address", () => {
  it("rotating it stops the old address at once", async () => {
    const o = await signUpWithBusiness(t.app, "rotate");
    const before = o.business.intakeAddress as string;
    const after = (await o.req("POST", "/settings/rotate-intake")).body.intakeAddress as string;
    expect(after).not.toBe(before);
    const webhook = (to: string, id: string) => t.app.inject({
      method: "POST", url: "/webhooks/resend/inbound", headers: { "content-type": "application/json", "x-fake-signature": "valid" },
      payload: JSON.stringify({ type: "email.received", data: { email_id: id, from: o.email, to: [to], subject: "x" } }),
    });
    expect(JSON.parse((await webhook(before, `rot1_${Date.now()}`)).body).outcome).toBe("dropped");
    expect(JSON.parse((await webhook(after, `rot2_${Date.now()}`)).body).outcome).toBe("job");
  });
});
