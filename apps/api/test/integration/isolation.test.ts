// Endpoint isolation suite (design §23, launch gate): seeds two businesses and
// asserts that business A can neither see nor touch anything of business B
// through any route — and that it gets 404, not 403, so existence is not leaked.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildTestApp, signUpWithBusiness, type Client } from "./helpers.ts";

let t: Awaited<ReturnType<typeof buildTestApp>>;
let A: Client & { business: any };
let B: Client & { business: any };
const b: Record<string, any> = {};

beforeAll(async () => {
  t = await buildTestApp();
  A = await signUpWithBusiness(t.app, "iso-a");
  B = await signUpWithBusiness(t.app, "iso-b");
  b.customer = (await B.req("POST", "/customers", { name: "B's customer", email: "bc@example.com" })).body;
  b.item = (await B.req("POST", "/price-book", { kind: "material", name: "B part", unit: "each", rateCents: 100 })).body;
  b.assembly = (await B.req("POST", "/price-book", { kind: "assembly", name: "B asm", unit: "each", components: [{ componentId: b.item.id, qty: "1" }] })).body;
  b.quote = (await B.req("POST", "/quotes", { customerId: b.customer.id })).body;
  b.quote = (await B.req("PATCH", `/quotes/${b.quote.id}`, { lockVersion: 0, lines: [{ description: "B line", qty: "1", unit: "each", unitPriceCents: 100 }] })).body;
});
afterAll(async () => { await t.close(); });

describe("A cannot read B", () => {
  it("lists contain only A's rows", async () => {
    for (const path of ["/customers", "/price-book?includeInactive=true", "/quotes"]) {
      const r = await A.req("GET", path);
      expect(r.status).toBe(200);
      const ids = (r.body as { id: string }[]).map((x) => x.id);
      expect(ids).not.toContain(b.customer.id);
      expect(ids).not.toContain(b.item.id);
      expect(ids).not.toContain(b.quote.id);
    }
  });

  it("settings show A's business, never B's", async () => {
    const r = await A.req("GET", "/settings/business");
    expect(r.body.id).toBe(A.business.id);
    expect(r.body.intakeAddress).not.toBe(B.business.intakeAddress);
  });

  it.each([
    ["GET", () => `/customers/${b.customer.id}`],
    ["GET", () => `/quotes/${b.quote.id}`],
  ])("%s %s → 404", async (method, path) => {
    const r = await A.req(method as "GET", path());
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).not.toContain("B line");
  });
});

describe("A cannot change B", () => {
  it("PATCH B's customer → 404", async () => {
    expect((await A.req("PATCH", `/customers/${b.customer.id}`, { name: "pwned" })).status).toBe(404);
  });
  it("PATCH / DELETE B's price-book item → 404", async () => {
    expect((await A.req("PATCH", `/price-book/${b.item.id}`, { rateCents: 1 })).status).toBe(404);
    expect((await A.req("DELETE", `/price-book/${b.item.id}`)).status).toBe(404);
  });
  it("PATCH B's quote, add lines to it, or preview it → 404", async () => {
    expect((await A.req("PATCH", `/quotes/${b.quote.id}`, { lockVersion: b.quote.lockVersion, terms: "pwned" })).status).toBe(404);
    expect((await A.req("POST", `/quotes/${b.quote.id}/lines/from-price-book`, { lockVersion: b.quote.lockVersion, priceBookItemId: b.item.id })).status).toBe(404);
    expect((await A.req("POST", `/quotes/${b.quote.id}/preview-totals`, { lines: [] })).status).toBe(404);
  });

  it("B's data is unchanged afterwards", async () => {
    const q = (await B.req("GET", `/quotes/${b.quote.id}`)).body;
    expect(q.terms).not.toBe("pwned");
    expect(q.lockVersion).toBe(b.quote.lockVersion);
    const item = (await B.req("GET", "/price-book")).body.find((i: { id: string }) => i.id === b.item.id);
    expect(item).toMatchObject({ rateCents: 100, active: true });
    expect((await B.req("GET", `/customers/${b.customer.id}`)).body.name).toBe("B's customer");
  });
});

describe("A cannot reference B's rows from its own", () => {
  let aQuote: any;
  beforeAll(async () => {
    const cust = (await A.req("POST", "/customers", { name: "A cust", phone: "555-0100" })).body;
    aQuote = (await A.req("POST", "/quotes", { customerId: cust.id })).body;
  });

  it("cannot open a quote for B's customer", async () => {
    expect((await A.req("POST", "/quotes", { customerId: b.customer.id })).status).toBe(404);
  });
  it("cannot add B's price-book item or assembly to its quote", async () => {
    expect((await A.req("POST", `/quotes/${aQuote.id}/lines/from-price-book`, { lockVersion: 0, priceBookItemId: b.item.id })).status).toBe(404);
    expect((await A.req("POST", `/quotes/${aQuote.id}/lines/from-price-book`, { lockVersion: 0, priceBookItemId: b.assembly.id })).status).toBe(404);
  });
  it("cannot point a line at B's price-book item", async () => {
    const r = await A.req("PATCH", `/quotes/${aQuote.id}`, { lockVersion: 0, lines: [{ description: "x", qty: "1", unit: "each", unitPriceCents: 1, priceBookItemId: b.item.id }] });
    expect(r.body.error.code).toBe("UNKNOWN_PRICE_BOOK_ITEM");
  });
  it("cannot adopt B's quote line by id", async () => {
    const r = await A.req("PATCH", `/quotes/${aQuote.id}`, { lockVersion: 0, lines: [{ id: b.quote.lines[0].id, description: "x", qty: "1", unit: "each", unitPriceCents: 1 }] });
    expect(r.body.error.code).toBe("UNKNOWN_LINE");
  });
  it("cannot build an assembly from B's items", async () => {
    const r = await A.req("POST", "/price-book", { kind: "assembly", name: "steal", unit: "each", components: [{ componentId: b.item.id, qty: "1" }] });
    expect(r.body.error.code).toBe("UNKNOWN_COMPONENT");
  });
});
