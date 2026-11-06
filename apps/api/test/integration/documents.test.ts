// Days 11–15 (design §14, §19, §20): approval, sending, outcomes, invoices,
// payments and reminders, ending in the exit test: the full loop.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { buildTestApp, signUpWithBusiness, ORIGIN } from "./helpers.ts";
import { Q } from "../../src/queue.ts";
import { withTenant } from "../../src/db/client.ts";
import { QUOTE_TRANSITIONS, INVOICE_TRANSITIONS, transitionQuote, transitionInvoice } from "../../src/services/transitions.ts";
import { sendDocument, sendFailed } from "../../src/jobs/sendDocument.ts";
import { invoiceReminder } from "../../src/jobs/invoiceReminder.ts";
import { expirySweep } from "../../src/jobs/expirySweep.ts";
import { stuckSweep } from "../../src/jobs/stuckSweep.ts";

type T = Awaited<ReturnType<typeof buildTestApp>>;
type Owner = Awaited<ReturnType<typeof signUpWithBusiness>>;
let t: T;
let A: Owner;
let customerId: string;

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const PRICED = [{ description: "Electrician labour", qty: "2", unit: "hour", unitPriceCents: 9500 }, { description: "GFCI receptacle", qty: "3", unit: "each", unitPriceCents: 3995 }];
// 19000 + 11985 = 30985; HST 13% = 4028.05 → 4028; total 35013

async function draft(o: Owner = A, cust = customerId, lines: object[] = PRICED, extra: object = {}) {
  const q = (await o.req("POST", "/quotes", { customerId: cust })).body;
  const r = await o.req("PATCH", `/quotes/${q.id}`, { lockVersion: 0, lines, ...extra });
  expect(r.status).toBe(200);
  return r.body;
}
async function approved(o: Owner = A, cust = customerId, lines: object[] = PRICED, extra: object = {}) {
  const q = await draft(o, cust, lines, extra);
  const r = await o.req("POST", `/quotes/${q.id}/approve`, { lockVersion: q.lockVersion });
  expect(r.status).toBe(200);
  return r.body;
}
async function sent(o: Owner = A, cust = customerId, lines: object[] = PRICED, extra: object = {}) {
  const q = await approved(o, cust, lines, extra);
  expect((await o.req("POST", `/quotes/${q.id}/send`)).status).toBe(200);
  await t.drain(Q.sendDocument);
  return (await o.req("GET", `/quotes/${q.id}`)).body;
}
async function accepted(extra: object = {}) {
  const q = await sent(A, customerId, PRICED, extra);
  return (await A.req("POST", `/quotes/${q.id}/outcome`, { outcome: "accepted" })).body;
}
async function sentInvoice(quoteId: string, kind = "final") {
  const inv = (await A.req("POST", `/quotes/${quoteId}/convert`, { kind })).body;
  expect((await A.req("POST", `/invoices/${inv.id}/send`)).status).toBe(200);
  await t.drain(Q.sendDocument);
  return (await A.req("GET", `/invoices/${inv.id}`)).body;
}
const pay = (id: string, amountCents: number, key = randomUUID()) =>
  A.req("POST", `/invoices/${id}/payments`, { amountCents, method: "e-transfer", receivedOn: "2026-11-05", idempotencyKey: key });

beforeAll(async () => {
  t = await buildTestApp();
  A = await signUpWithBusiness(t.app, "docs");
  await A.req("PATCH", "/settings/business", { replyToEmail: "dan@danselectric.example" });
  await t.admin.query("update businesses set monthly_quote_limit = null where id = $1", [A.business.id]);
  customerId = (await A.req("POST", "/customers", { name: "François Lévesque", email: "francois@example.com", siteAddress: "12 rue Saint-Jérôme" })).body.id;
});
afterAll(async () => { await t.close(); });
beforeEach(async () => {
  for (const q of Object.values(Q)) await t.boss.deleteAllJobs(q);
  t.mailer.sent.length = 0;
  t.mailer.state.failNext = 0;
});

describe("approval", () => {
  it("lists everything that blocks approval, with stable codes", async () => {
    const noTax = await signUpWithBusiness(t.app, "notax");
    await noTax.req("PATCH", "/settings/business", { taxComponents: [] });
    const q = (await noTax.req("POST", `/jobs`, { text: "x" })).body;
    expect(q.id).toBeTruthy();
    const blank = (await noTax.req("POST", `/jobs/${q.id}/quote`)).body;
    const r = await noTax.req("POST", `/quotes/${blank.id}/approve`, { lockVersion: 0 });
    expect(r.status).toBe(422);
    expect(r.body.error.details.blockers).toEqual(["NO_LINES", "NO_CUSTOMER_CONTACT", "NO_TAX_CONFIG"]);
  });

  it("refuses unpriced lines and stale versions", async () => {
    const q = await draft(A, customerId, [{ description: "No price", qty: "1", unit: "each", unitPriceCents: null }]);
    const r = await A.req("POST", `/quotes/${q.id}/approve`, { lockVersion: q.lockVersion });
    expect(r.body.error.code).toBe("UNPRICED_LINES");
    expect((await A.req("POST", `/quotes/${q.id}/approve`, { lockVersion: 99 })).body.error.code).toBe("STALE_QUOTE");
  });

  it("freezes a snapshot: later price-book, tax or customer changes don't touch it", async () => {
    const q = await approved();
    expect(q).toMatchObject({ status: "approved", subtotalCents: 30985, taxCents: 4028, totalCents: 35013 });
    await A.req("PATCH", "/settings/business", { taxComponents: [{ name: "HST", ratePpm: 150_000, regNo: null }] });
    await A.req("POST", `/quotes/${q.id}/send`);
    await t.drain(Q.sendDocument);
    expect(t.mailer.sent[0]!.text).toContain("$350.13");
    await A.req("PATCH", "/settings/business", { taxComponents: [{ name: "HST", ratePpm: 130_000, regNo: null }] });
  });

  it("editing an approved quote sends it back to draft, and re-approval isn't counted twice", async () => {
    const q = await approved();
    const month = "date_trunc('month', current_date)";
    const count = async () => (await t.admin.query(`select quotes_approved as n from usage_counters where business_id = $1 and month = ${month}`, [A.business.id])).rows[0].n;
    const before = await count();
    const edited = (await A.req("PATCH", `/quotes/${q.id}`, { lockVersion: q.lockVersion, terms: "New terms" })).body;
    expect(edited.status).toBe("draft");
    const { rows } = await t.admin.query("select snapshot, approved_by from quotes where id = $1", [q.id]);
    expect(rows[0]).toEqual({ snapshot: null, approved_by: null });
    await A.req("POST", `/quotes/${q.id}/approve`, { lockVersion: edited.lockVersion });
    expect(await count()).toBe(before);
  });

  it("enforces the monthly plan limit", async () => {
    const S = await signUpWithBusiness(t.app, "solo");
    const c = (await S.req("POST", "/customers", { name: "C", phone: "5550100" })).body.id;
    await t.admin.query("update businesses set monthly_quote_limit = 1 where id = $1", [S.business.id]);
    await approved(S, c);
    const q = await draft(S, c);
    expect((await S.req("POST", `/quotes/${q.id}/approve`, { lockVersion: q.lockVersion })).body.error.code).toBe("PLAN_LIMIT_REACHED");
  });
});

describe("every illegal transition is refused", () => {
  const quoteStates = Object.keys(QUOTE_TRANSITIONS) as (keyof typeof QUOTE_TRANSITIONS)[];
  const invoiceStates = Object.keys(INVOICE_TRANSITIONS) as (keyof typeof INVOICE_TRANSITIONS)[];

  it("quotes: all (from, to) pairs", async () => {
    const q = await approved();
    for (const from of quoteStates) for (const to of quoteStates) {
      await t.admin.query("update quotes set status = $1 where id = $2", [from, q.id]);
      const attempt = withTenant(t.db, A.business.id, (tx) => transitionQuote(tx, A.business.id, q.id, to, "test"));
      if (QUOTE_TRANSITIONS[from].includes(to)) await expect(attempt, `${from}→${to}`).resolves.toMatchObject({ status: to });
      else await expect(attempt, `${from}→${to}`).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    }
  });

  it("invoices: all (from, to) pairs", async () => {
    const q = await accepted();
    const inv = (await A.req("POST", `/quotes/${q.id}/convert`, {})).body;
    for (const from of invoiceStates) for (const to of invoiceStates) {
      await t.admin.query("update invoices set status = $1 where id = $2", [from, inv.id]);
      const attempt = withTenant(t.db, A.business.id, (tx) => transitionInvoice(tx, A.business.id, inv.id, to, "test"));
      if (INVOICE_TRANSITIONS[from].includes(to)) await expect(attempt, `${from}→${to}`).resolves.toMatchObject({ status: to });
      else await expect(attempt, `${from}→${to}`).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    }
  });

  it("no route can send a quote from any state but approved", async () => {
    const q = await approved();
    for (const from of quoteStates.filter((s) => s !== "approved")) {
      await t.admin.query("update quotes set status = $1 where id = $2", [from, q.id]);
      for (const path of ["send", "share"]) {
        expect((await A.req("POST", `/quotes/${q.id}/${path}`)).status, `${path} from ${from}`).toBe(409);
      }
    }
    expect(t.mailer.sent).toHaveLength(0);
  });

  it("the send job emails nothing unless the document is in sending", async () => {
    const q = await approved();
    for (const from of quoteStates.filter((s) => s !== "sending")) {
      await t.admin.query("update quotes set status = $1 where id = $2", [from, q.id]);
      expect(await sendDocument(t.worker, { businessId: A.business.id, kind: "quote", documentId: q.id })).toEqual({ result: "skipped" });
    }
    expect(t.mailer.sent).toHaveLength(0);
  });

  it("a draft can never reach a customer", async () => {
    const q = await draft();
    expect((await A.req("POST", `/quotes/${q.id}/send`)).body.error.code).toBe("ILLEGAL_TRANSITION");
    expect((await A.req("POST", `/quotes/${q.id}/share`)).body.error.code).toBe("ILLEGAL_TRANSITION");
    expect(t.mailer.sent).toHaveLength(0);
  });
});

describe("sending", () => {
  it("emails the stored bytes, with Reply-To, and records the hash", async () => {
    const q = await sent();
    expect(q).toMatchObject({ status: "sent", sentVia: "email", hasPdf: true });
    const m = t.mailer.sent[0]!;
    expect(m).toMatchObject({ to: "francois@example.com", replyTo: "dan@danselectric.example", fromName: "docs Electric" });
    const { rows } = await t.admin.query("select pdf_object_key, pdf_sha256 from quotes where id = $1", [q.id]);
    const stored = await t.store.get(rows[0].pdf_object_key);
    expect(rows[0].pdf_object_key.startsWith(`${A.business.id}/`)).toBe(true);
    expect(sha(m.attachments![0]!.content)).toBe(rows[0].pdf_sha256);
    expect(sha(stored.body)).toBe(rows[0].pdf_sha256);
    const dl = await t.app.inject({ method: "GET", url: `/quotes/${q.id}/pdf`, headers: { cookie: A.cookie } });
    expect(sha(dl.rawPayload)).toBe(rows[0].pdf_sha256);
    expect(dl.headers["content-disposition"]).toMatch(/^attachment; filename="Quote-Q-\d{4}-v1\.pdf"/);
  });

  it("keeps a long assembly name whole, because it prints on the document", async () => {
    const part = (await A.req("POST", "/price-book", { kind: "material", name: "Part", unit: "each", rateCents: 100 })).body;
    const name = "EV charger install — 48 A Level 2 (charger supplied by customer, up to 30 ft from the panel)";
    const asm = (await A.req("POST", "/price-book", { kind: "assembly", name, unit: "each", components: [{ componentId: part.id, qty: "1" }] })).body;
    let q = (await A.req("POST", "/quotes", { customerId })).body;
    q = (await A.req("POST", `/quotes/${q.id}/lines/from-price-book`, { lockVersion: 0, priceBookItemId: asm.id })).body;
    expect(q.lines[0].groupKey.split(":").slice(1).join(":")).toBe(name);
    // A saved edit round-trips the key through the API's validation.
    const lines = q.lines.map((l: any) => ({ id: l.id, description: l.description, qty: l.qty, unit: l.unit, unitPriceCents: l.unitPriceCents, groupKey: l.groupKey }));
    expect((await A.req("PATCH", `/quotes/${q.id}`, { lockVersion: q.lockVersion, lines })).status).toBe(200);
  });

  it("refuses edits while a quote is sending", async () => {
    const q = await approved();
    await A.req("POST", `/quotes/${q.id}/send`);
    const r = await A.req("PATCH", `/quotes/${q.id}`, { lockVersion: q.lockVersion, terms: "too late" });
    expect(r.body.error.code).toBe("QUOTE_SENDING");
  });

  it("a crash after the provider accepted the email does not send it twice", async () => {
    const q = await approved();
    await A.req("POST", `/quotes/${q.id}/send`);
    const data = { businessId: A.business.id, kind: "quote" as const, documentId: q.id };
    // The worker dies after the provider call but before its commit.
    const crashing = { ...t.worker, mailer: { send: async (m: any) => { await t.mailer.send(m); throw new Error("killed"); } } };
    await expect(sendDocument(crashing, data)).rejects.toThrow("killed");
    expect((await A.req("GET", `/quotes/${q.id}`)).body.status).toBe("sending");

    // pg-boss retries, or the sweep picks it up: same PDF, same idempotency key.
    const before = (await t.admin.query("select pdf_sha256 from quotes where id = $1", [q.id])).rows[0].pdf_sha256;
    expect(await sendDocument(t.worker, data)).toEqual({ result: "sent" });
    expect(t.mailer.state.attempts).toBeGreaterThan(1);
    expect(t.mailer.sent).toHaveLength(1);
    expect((await t.admin.query("select pdf_sha256 from quotes where id = $1", [q.id])).rows[0].pdf_sha256).toBe(before);
    expect(await sendDocument(t.worker, data)).toEqual({ result: "skipped" });
    expect(t.mailer.sent).toHaveLength(1);
  });

  it("the sweep re-drives a document left in sending", async () => {
    const q = await approved();
    await A.req("POST", `/quotes/${q.id}/send`);
    await t.boss.deleteAllJobs(Q.sendDocument);           // the queued job is lost
    await t.admin.query("update quotes set updated_at = now() - interval '20 minutes' where id = $1", [q.id]);
    expect((await stuckSweep(t.worker)).documents).toBeGreaterThanOrEqual(1);
    await t.drain(Q.sendDocument);
    expect((await A.req("GET", `/quotes/${q.id}`)).body.status).toBe("sent");
    expect(t.mailer.sent).toHaveLength(1);
  });

  it("permanent failure returns it to approved with the error shown, and Send works again", async () => {
    const q = await approved();
    await A.req("POST", `/quotes/${q.id}/send`);
    t.mailer.state.failNext = 1;
    const data = { businessId: A.business.id, kind: "quote" as const, documentId: q.id };
    await expect(sendDocument(t.worker, data)).rejects.toThrow("provider unavailable");
    await sendFailed(t.worker, data);                     // retries exhausted → dead letter
    const back = (await A.req("GET", `/quotes/${q.id}`)).body;
    expect(back.status).toBe("approved");
    expect(back.lastSendError).toMatch(/could not be sent/);
    await t.drain(Q.notify);
    expect(t.mailer.sent.map((m) => m.subject)).toContain("A document could not be sent");

    await A.req("POST", `/quotes/${q.id}/send`);
    await t.drain(Q.sendDocument);
    expect((await A.req("GET", `/quotes/${q.id}`)).body).toMatchObject({ status: "sent", lastSendError: null });
  });

  it("a text-only customer: email send is refused, sharing the PDF works", async () => {
    const c = (await A.req("POST", "/customers", { name: "Text Only", phone: "647-555-0100" })).body.id;
    const q = await approved(A, c);
    expect((await A.req("POST", `/quotes/${q.id}/send`)).body.error.code).toBe("NO_CUSTOMER_EMAIL");
    const r = await A.req("POST", `/quotes/${q.id}/share`);
    expect(r.body).toMatchObject({ status: "sent", sentVia: "manual_share", pdfUrl: `/quotes/${q.id}/pdf` });
    expect((await t.app.inject({ method: "GET", url: r.body.pdfUrl, headers: { cookie: A.cookie } })).rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    expect(t.mailer.sent).toHaveLength(0);
  });

  it("a bounce blocks the address and tells the owner", async () => {
    const c = (await A.req("POST", "/customers", { name: "Bouncy", email: "Bouncy@Example.com" })).body.id;
    const q = await sent(A, c);
    const { rows } = await t.admin.query("select provider_email_id as id from quotes where id = $1", [q.id]);
    const event = (type: string, valid = true) => t.app.inject({
      method: "POST", url: "/webhooks/resend/events", payload: JSON.stringify({ type, data: { email_id: rows[0].id, to: ["Bouncy@Example.com"] } }),
      headers: { "content-type": "application/json", ...(valid ? { "x-fake-signature": "valid" } : {}) },
    });
    expect((await event("email.bounced", false)).statusCode).toBe(401);
    expect(JSON.parse((await event("email.delivered")).body).outcome).toBe("delivered");
    expect(JSON.parse((await event("email.bounced")).body).outcome).toBe("bounced");
    await t.drain(Q.notify);
    expect(t.mailer.sent.map((m) => m.subject)).toContain("An email to a customer bounced");
    const next = await approved(A, c);
    expect((await A.req("POST", `/quotes/${next.id}/send`)).body.error.code).toBe("RECIPIENT_SUPPRESSED");
  });
});

describe("outcome, revise, expiry", () => {
  it("accepting optional lines recomputes with the quoted tax rates and keeps the sent snapshot", async () => {
    const lines = [...PRICED, { description: "Surge protector", qty: "1", unit: "each", unitPriceCents: 24900, optional: true }, { description: "Dimmer", qty: "1", unit: "each", unitPriceCents: 4500, optional: true }];
    const q = await sent(A, customerId, lines);
    expect(q).toMatchObject({ totalCents: 35013, optionalTotalCents: 29400 });
    await A.req("PATCH", "/settings/business", { taxComponents: [{ name: "HST", ratePpm: 150_000, regNo: null }] });
    const surge = q.lines.find((l: any) => l.description === "Surge protector").id;
    const a = (await A.req("POST", `/quotes/${q.id}/outcome`, { outcome: "accepted", acceptedOptionalLineIds: [surge] })).body;
    await A.req("PATCH", "/settings/business", { taxComponents: [{ name: "HST", ratePpm: 130_000, regNo: null }] });
    // 30985 + 24900 = 55885; 13% = 7265.05 → 7265; total 63150
    expect(a).toMatchObject({ status: "accepted", subtotalCents: 55885, taxCents: 7265, totalCents: 63150, optionalTotalCents: 4500 });
    const { rows } = await t.admin.query("select snapshot->>'totalCents' as sent, accepted_snapshot->>'totalCents' as acc from quotes where id = $1", [q.id]);
    expect(rows[0]).toEqual({ sent: "35013", acc: "63150" });
    const inv = (await A.req("POST", `/quotes/${q.id}/convert`, {})).body;
    expect(inv.amountCents).toBe(63150);
  });

  it("rejects an accepted line that isn't optional", async () => {
    const q = await sent();
    const r = await A.req("POST", `/quotes/${q.id}/outcome`, { outcome: "accepted", acceptedOptionalLineIds: [q.lines[0].id] });
    expect(r.body.error.code).toBe("NOT_AN_OPTIONAL_LINE");
  });

  it("revise supersedes the sent quote and opens the next version of the same number", async () => {
    const q = await sent();
    const r = await A.req("POST", `/quotes/${q.id}/revise`);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ number: q.number, version: 2, status: "draft", parentQuoteId: q.id, totalCents: q.totalCents });
    expect((await A.req("GET", `/quotes/${q.id}`)).body.status).toBe("superseded");
    expect((await A.req("PATCH", `/quotes/${q.id}`, { lockVersion: q.lockVersion, terms: "x" })).body.error.code).toBe("QUOTE_NOT_EDITABLE");
    expect((await A.req("POST", `/quotes/${q.id}/revise`)).body.error.code).toBe("ILLEGAL_TRANSITION");
  });

  it("the sweep expires quotes past their date in the business's timezone; a late yes still counts", async () => {
    const q = await sent();
    await t.admin.query(`update quotes set snapshot = jsonb_set(snapshot, '{expiresOn}', '"2020-01-01"') where id = $1`, [q.id]);
    expect((await expirySweep(t.worker)).expired).toBeGreaterThanOrEqual(1);
    await t.drain(Q.notify);
    expect((await A.req("GET", `/quotes/${q.id}`)).body.status).toBe("expired");
    expect(t.mailer.sent.map((m) => m.subject)).toContain("A quote has expired");
    expect((await A.req("POST", `/quotes/${q.id}/outcome`, { outcome: "declined" })).status).toBe(409);
    expect((await A.req("POST", `/quotes/${q.id}/outcome`, { outcome: "accepted" })).body.status).toBe("accepted");
  });
});

describe("invoices", () => {
  it("only an accepted quote converts; conversion is idempotent", async () => {
    const q = await sent();
    expect((await A.req("POST", `/quotes/${q.id}/convert`, {})).body.error.code).toBe("NOT_ACCEPTED");
    await A.req("POST", `/quotes/${q.id}/outcome`, { outcome: "accepted" });
    const a = (await A.req("POST", `/quotes/${q.id}/convert`, {})).body;
    const b = (await A.req("POST", `/quotes/${q.id}/convert`, {})).body;
    expect(a.id).toBe(b.id);
    expect(a).toMatchObject({ status: "issued", amountCents: 35013, kind: "final", dueDate: null });
    expect(a.ref).toMatch(/^INV-\d{4}$/);
  });

  it("deposit + final sum to the quote total exactly, with two taxes", async () => {
    const B = await signUpWithBusiness(t.app, "qc", "QC-GST-QST");
    const c = (await B.req("POST", "/customers", { name: "Hélène", email: "h@example.com" })).body.id;
    const q = await sent(B, c, PRICED, { depositPct: 30 });
    await B.req("POST", `/quotes/${q.id}/outcome`, { outcome: "accepted" });
    const dep = (await B.req("POST", `/quotes/${q.id}/convert`, { kind: "deposit" })).body;
    const fin = (await B.req("POST", `/quotes/${q.id}/convert`, { kind: "final" })).body;
    expect(dep.amountCents + fin.amountCents).toBe(q.totalCents);
    expect((await B.req("POST", `/quotes/${q.id}/convert`, { kind: "deposit" })).body.id).toBe(dep.id);
    const { rows } = await t.admin.query("select kind, tax_cents, snapshot from invoices where quote_id = $1 order by number", [q.id]);
    expect(rows[0].tax_cents + rows[1].tax_cents).toBe(q.taxCents);
    expect(rows[0].snapshot.taxes.reduce((s: number, x: any) => s + x.amountCents, 0)).toBe(rows[0].tax_cents);
    expect(rows[1].snapshot).toMatchObject({ lessDepositRef: dep.ref, lessDepositCents: dep.amountCents, totalCents: q.totalCents });
  });

  it("no deposit invoice on a quote without one, or after the final", async () => {
    const q = await accepted();
    expect((await A.req("POST", `/quotes/${q.id}/convert`, { kind: "deposit" })).body.error.code).toBe("NO_DEPOSIT");
    const q2 = await accepted({ depositPct: 25 });
    await A.req("POST", `/quotes/${q2.id}/convert`, { kind: "final" });
    expect((await A.req("POST", `/quotes/${q2.id}/convert`, { kind: "deposit" })).body.error.code).toBe("FINAL_EXISTS");
  });

  it("sets the due date on send, not on creation, and schedules reminders at 09:00 local", async () => {
    const q = await accepted();
    const inv = await sentInvoice(q.id);
    expect(inv.status).toBe("sent");
    expect(inv.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(t.mailer.sent.at(-1)!.subject).toMatch(/^Invoice INV-/);
    expect(t.mailer.sent.at(-1)!.attachments).toHaveLength(1);
    const { rows } = await t.admin.query(
      `select data->>'stage' as stage, start_after from pgboss.job where name = 'invoice-reminder' and data->>'invoiceId' = $1 order by (data->>'stage')::int`, [inv.id]);
    expect(rows.map((r) => r.stage)).toEqual(["7", "14"]);
    const local = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", hour: "2-digit", hourCycle: "h23" }).format(d);
    expect(local(rows[0].start_after)).toBe("09");
    expect(rows[1].start_after - rows[0].start_after).toBeGreaterThan(6 * 86_400_000);
  });

  it("records partial payments, refuses overpayment, is idempotent, and reversal reopens", async () => {
    const inv = await sentInvoice((await accepted()).id);
    const key = randomUUID();
    expect((await pay(inv.id, 10000, key)).body).toMatchObject({ paidCents: 10000, balanceCents: 25013, status: "sent" });
    expect((await pay(inv.id, 10000, key)).body.paidCents).toBe(10000);       // double-tap
    expect((await pay(inv.id, 99999)).body.error.code).toBe("OVERPAYMENT");
    expect((await pay(inv.id, 25013)).body).toMatchObject({ status: "paid", balanceCents: 0 });
    expect((await pay(inv.id, -5000)).body).toMatchObject({ status: "sent", balanceCents: 5000 });
    expect((await pay(inv.id, -999999)).body.error.code).toBe("REVERSAL_TOO_LARGE");
    expect((await A.req("GET", `/invoices/${inv.id}`)).body.payments).toHaveLength(3);
  });

  it("overdue is derived; reminders state the balance, fire once per stage, and stop when paid", async () => {
    const inv = await sentInvoice((await accepted()).id);
    expect((await A.req("GET", `/invoices/${inv.id}`)).body.overdue).toBe(false);
    await t.admin.query("update invoices set due_date = current_date - 8 where id = $1", [inv.id]);
    expect((await A.req("GET", "/invoices")).body.find((i: any) => i.id === inv.id).overdue).toBe(true);

    await pay(inv.id, 5013);
    const data = { businessId: A.business.id, invoiceId: inv.id, stage: 7 as const };
    expect(await invoiceReminder(t.worker, data)).toEqual({ result: "sent" });
    expect(await invoiceReminder(t.worker, data)).toEqual({ result: "no-op" });
    const m = t.mailer.sent.at(-1)!;
    expect(m.subject).toMatch(/^Reminder/);
    expect(m.text).toContain("$300.00");
    expect(m.attachments).toHaveLength(1);
    await pay(inv.id, 30000);
    expect(await invoiceReminder(t.worker, { ...data, stage: 14 })).toEqual({ result: "no-op" });
  });

  it("a customer with no email gets no reminder; sharing still starts the clock", async () => {
    const c = (await A.req("POST", "/customers", { name: "Phone", phone: "647-555-0111" })).body.id;
    const q = await approved(A, c);
    await A.req("POST", `/quotes/${q.id}/share`);
    await A.req("POST", `/quotes/${q.id}/outcome`, { outcome: "accepted" });
    const inv = (await A.req("POST", `/quotes/${q.id}/convert`, {})).body;
    expect((await A.req("POST", `/invoices/${inv.id}/send`)).body.error.code).toBe("NO_CUSTOMER_EMAIL");
    const s = (await A.req("POST", `/invoices/${inv.id}/share`)).body;
    expect(s).toMatchObject({ status: "sent", sentVia: "manual_share" });
    expect(s.dueDate).toBeTruthy();
    expect(await invoiceReminder(t.worker, { businessId: A.business.id, invoiceId: inv.id, stage: 7 })).toEqual({ result: "no-op" });
  });
});

describe("isolation for documents", () => {
  it("another business cannot act on A's quotes or invoices", async () => {
    const q = await accepted();
    const inv = (await A.req("POST", `/quotes/${q.id}/convert`, {})).body;
    const B = await signUpWithBusiness(t.app, "docs-b");
    for (const [m, p, b] of [
      ["POST", `/quotes/${q.id}/approve`, { lockVersion: 0 }], ["POST", `/quotes/${q.id}/send`], ["POST", `/quotes/${q.id}/share`],
      ["POST", `/quotes/${q.id}/outcome`, { outcome: "declined" }], ["POST", `/quotes/${q.id}/revise`], ["POST", `/quotes/${q.id}/convert`, {}],
      ["GET", `/quotes/${q.id}/pdf`], ["GET", `/quotes/${q.id}/invoices`],
      ["GET", `/invoices/${inv.id}`], ["POST", `/invoices/${inv.id}/send`], ["POST", `/invoices/${inv.id}/share`], ["GET", `/invoices/${inv.id}/pdf`],
      ["POST", `/invoices/${inv.id}/payments`, { amountCents: 1, method: "x", receivedOn: "2026-11-05", idempotencyKey: "12345678" }],
    ] as const) {
      expect((await B.req(m, p, b)).status, `${m} ${p}`).toBe(404);
    }
    expect((await B.req("GET", "/invoices")).body).toEqual([]);
    expect((await A.req("GET", `/invoices/${inv.id}`)).body.status).toBe("issued");
  });
});

describe("Days 11–15 exit test", () => {
  it("message → draft → approve → sent PDF → accepted → deposit → final → partial payment → reminder → paid", async () => {
    t.setScript(() => ({
      isEnquiry: true, customer: { name: "Priya Shah", email: "priya@example.com", phone: null, siteAddress: "14 Elm Street" },
      jobType: "repair", summary: "Add a circuit", urgency: "soon", questions: [],
      lines: [{ description: "New circuit", priceBookItemId: null, qty: 2, qtyStated: true, unit: "each", kind: "material", sourceKind: "text", sourceQuote: "add 2 new circuits", confidence: 0.9 }],
    }));
    const job = (await A.req("POST", "/jobs", { text: "Please add 2 new circuits in the garage." })).body;
    await t.drain(Q.extract);
    const j = (await A.req("GET", `/jobs/${job.id}`)).body;
    let q = (await A.req("GET", `/quotes/${j.quoteId}`)).body;
    expect((await A.req("POST", `/quotes/${q.id}/approve`, { lockVersion: q.lockVersion })).body.error.code).toBe("UNPRICED_LINES");

    // The human prices the line and sets a 30% deposit.
    q = (await A.req("PATCH", `/quotes/${q.id}`, {
      lockVersion: q.lockVersion, depositPct: 30,
      lines: [{ id: q.lines[0].id, description: q.lines[0].description, qty: q.lines[0].qty, unit: q.lines[0].unit, unitPriceCents: 25000 }],
    })).body;
    expect(q.totalCents).toBe(56500);
    q = (await A.req("POST", `/quotes/${q.id}/approve`, { lockVersion: q.lockVersion })).body;
    await A.req("POST", `/quotes/${q.id}/send`);
    await t.drain(Q.sendDocument);
    expect(t.mailer.sent[0]).toMatchObject({ to: "priya@example.com" });
    expect(t.mailer.sent[0]!.attachments![0]!.filename).toMatch(/^Quote-Q-\d{4}-v1\.pdf$/);

    await A.req("POST", `/quotes/${q.id}/outcome`, { outcome: "accepted" });
    const dep = await sentInvoice(q.id, "deposit");
    expect(dep.amountCents).toBe(16950);
    expect((await pay(dep.id, 16950)).body.status).toBe("paid");
    const fin = await sentInvoice(q.id, "final");
    expect(fin.amountCents).toBe(39550);
    expect((await pay(fin.id, 20000)).body).toMatchObject({ status: "sent", balanceCents: 19550 });

    // The test due date arrives: make the +7 reminder due and let the queue fire it.
    await t.admin.query(`update pgboss.job set start_after = now() where name = 'invoice-reminder' and data->>'invoiceId' = $1 and data->>'stage' = '7'`, [fin.id]);
    const ran = await t.drain(Q.invoiceReminder);
    expect(ran.find((r) => r.data.invoiceId === fin.id)!.result).toEqual({ result: "sent" });
    expect(t.mailer.sent.at(-1)!.text).toContain("$195.50");

    expect((await pay(fin.id, 19550)).body.status).toBe("paid");
    await t.admin.query(`update pgboss.job set start_after = now() where name = 'invoice-reminder' and data->>'invoiceId' = $1`, [fin.id]);
    const after = await t.drain(Q.invoiceReminder);
    expect(after.every((r) => (r.result as { result: string }).result === "no-op")).toBe(true);

    // Nothing left the system without an approval on record.
    const { rows } = await t.admin.query(
      `select action from audit_events where entity = 'quote' and entity_id = $1 order by id`, [q.id]);
    const actions = rows.map((r) => r.action);
    expect(actions.indexOf("quote.approved")).toBeLessThan(actions.indexOf("quote.sent"));
    expect(actions).toContain("quote.accepted");
  });
});
