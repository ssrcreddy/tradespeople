import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildTestApp, signUp, signUpWithBusiness, type Client } from "./helpers.ts";

let t: Awaited<ReturnType<typeof buildTestApp>>;
beforeAll(async () => { t = await buildTestApp(); });
afterAll(async () => { await t.close(); });

describe("auth and business onboarding", () => {
  it("rejects unauthenticated calls", async () => {
    const r = await t.app.inject({ method: "GET", url: "/price-book" });
    expect(r.statusCode).toBe(401);
    expect(JSON.parse(r.body).error.code).toBe("UNAUTHENTICATED");
  });

  it("a signed-in user without a business is told to create one", async () => {
    const c = await signUp(t.app, "nobiz");
    expect((await c.req("GET", "/quotes")).body.error.code).toBe("NO_BUSINESS");
  });

  it("creates a business with an intake address and owner membership", async () => {
    const c = await signUp(t.app, "owner");
    const r = await c.req("POST", "/businesses", { name: "Dan's Electric", taxPreset: "QC-GST-QST" });
    expect(r.status).toBe(201);
    expect(r.body.intakeAddress).toMatch(/^quote\+[a-z0-9]{20,}@intake\.test$/);
    expect(r.body.taxComponents.map((x: { name: string }) => x.name)).toEqual(["GST", "QST"]);
    expect(r.body).not.toHaveProperty("intakeToken");
    expect((await c.req("POST", "/businesses", { name: "Second" })).body.error.code).toBe("ALREADY_IN_BUSINESS");
  });

  it("owner can update settings; values are validated", async () => {
    const c = await signUpWithBusiness(t.app, "settings");
    const ok = await c.req("PATCH", "/settings/business", { termsDays: 30, depositPctDefault: 25 });
    expect(ok.body).toMatchObject({ termsDays: 30, depositPctDefault: 25 });
    expect((await c.req("PATCH", "/settings/business", { depositPctDefault: 150 })).status).toBe(400);
  });

  it("refuses cookie-authenticated writes from another origin (CSRF)", async () => {
    const c = await signUpWithBusiness(t.app, "csrf");
    const r = await t.app.inject({
      method: "POST", url: "/customers",
      headers: { cookie: c.cookie, origin: "https://evil.example", "content-type": "application/json" },
      payload: { name: "x", phone: "123" },
    });
    expect(r.statusCode).toBe(403);
    const none = await t.app.inject({ method: "POST", url: "/customers", headers: { cookie: c.cookie, "content-type": "application/json" }, payload: { name: "x", phone: "123" } });
    expect(none.statusCode).toBe(403);
  });
});

describe("price book", () => {
  let c: Client;
  beforeAll(async () => { c = await signUpWithBusiness(t.app, "pb"); });

  it("computes a material's sell rate from cost + markup", async () => {
    const r = await c.req("POST", "/price-book", { kind: "material", name: "GFCI", unit: "each", costCents: 1234, markupPpm: 350_000 });
    expect(r.status).toBe(201);
    expect(r.body.rateCents).toBe(1666);
  });

  it("builds an assembly whose price is the sum of its parts", async () => {
    const brk = (await c.req("POST", "/price-book", { kind: "material", name: "60 A breaker", unit: "each", rateCents: 6500 })).body;
    const cable = (await c.req("POST", "/price-book", { kind: "material", name: "6/3 cable", unit: "foot", rateCents: 450 })).body;
    const lab = (await c.req("POST", "/price-book", { kind: "labour", name: "Electrician", unit: "hour", rateCents: 9500 })).body;
    const asm = await c.req("POST", "/price-book", {
      kind: "assembly", name: "EV install", unit: "each", aliases: ["ev charger"],
      components: [{ componentId: brk.id, qty: "1" }, { componentId: cable.id, qty: "30" }, { componentId: lab.id, qty: "4" }],
    });
    expect(asm.status).toBe(201);
    expect(asm.body.rateCents).toBeNull();
    expect(asm.body.assemblyPriceCents).toBe(6500 + 13500 + 38000);
    expect(asm.body.components.map((x: { qty: string }) => x.qty)).toEqual(["1", "30", "4"]);

    // Changing a component's rate changes the assembly price.
    await c.req("PATCH", `/price-book/${lab.id}`, { rateCents: 10000 });
    const list = (await c.req("GET", "/price-book")).body;
    expect(list.find((i: { id: string }) => i.id === asm.body.id).assemblyPriceCents).toBe(6500 + 13500 + 40000);
  });

  it("rejects nested and empty assemblies", async () => {
    const asm = (await c.req("GET", "/price-book")).body.find((i: { kind: string }) => i.kind === "assembly");
    const nested = await c.req("POST", "/price-book", { kind: "assembly", name: "Nested", unit: "each", components: [{ componentId: asm.id, qty: "1" }] });
    expect(nested.body.error.code).toBe("NESTED_ASSEMBLY");
    const empty = await c.req("POST", "/price-book", { kind: "assembly", name: "Empty", unit: "each", components: [] });
    expect(empty.body.error.code).toBe("ASSEMBLY_EMPTY");
  });

  it("deactivates instead of deleting", async () => {
    const it1 = (await c.req("POST", "/price-book", { kind: "material", name: "Old part", unit: "each", rateCents: 100 })).body;
    expect((await c.req("DELETE", `/price-book/${it1.id}`)).status).toBe(204);
    expect((await c.req("GET", "/price-book")).body.some((i: { id: string }) => i.id === it1.id)).toBe(false);
    expect((await c.req("GET", "/price-book?includeInactive=true")).body.some((i: { id: string }) => i.id === it1.id)).toBe(true);
  });

  it("loads the electrical starter template once, with blank rates", async () => {
    const fresh = await signUpWithBusiness(t.app, "starter");
    const r = await fresh.req("POST", "/price-book/starter");
    expect(r.status).toBe(201);
    expect(r.body.assemblies).toBeGreaterThanOrEqual(4);
    const list = (await fresh.req("GET", "/price-book")).body as { kind: string; rateCents: number | null; assemblyPriceCents?: number | null; name: string }[];
    expect(list.filter((i) => i.kind !== "assembly").every((i) => i.rateCents === null)).toBe(true);
    const ev = list.find((i) => i.name.startsWith("EV charger install"))!;
    expect(ev.assemblyPriceCents).toBeNull();          // components not priced yet
    expect((await fresh.req("POST", "/price-book/starter")).body.error.code).toBe("PRICE_BOOK_NOT_EMPTY");
  });
});

describe("customers", () => {
  it("needs an email or a phone; phone-only is fine", async () => {
    const c = await signUpWithBusiness(t.app, "cust");
    expect((await c.req("POST", "/customers", { name: "No contact" })).body.error.code).toBe("NO_CUSTOMER_CONTACT");
    expect((await c.req("POST", "/customers", { name: "Phone only", phone: "647-555-0142" })).status).toBe(201);
    await c.req("POST", "/customers", { name: "A", email: "Same@Example.com" });
    expect((await c.req("POST", "/customers", { name: "B", email: "same@example.com" })).status).toBe(409);
  });
});

describe("quotes", () => {
  let c: Client;
  let customerId: string;
  beforeAll(async () => {
    c = await signUpWithBusiness(t.app, "q");
    customerId = (await c.req("POST", "/customers", { name: "Priya", email: "priya@example.com" })).body.id;
  });

  it("numbers quotes per business, starting at 1", async () => {
    const a = (await c.req("POST", "/quotes", { customerId })).body;
    const b = (await c.req("POST", "/quotes", { customerId })).body;
    expect([a.number, b.number]).toEqual([1, 2]);
    expect(a).toMatchObject({ status: "draft", version: 1, lockVersion: 0, totalCents: 0 });
    const other = await signUpWithBusiness(t.app, "q2");
    const oc = (await other.req("POST", "/customers", { name: "X", phone: "1234" })).body.id;
    expect((await other.req("POST", "/quotes", { customerId: oc })).body.number).toBe(1);
  });

  it("edits lines with optimistic locking and recomputes totals", async () => {
    const q = (await c.req("POST", "/quotes", { customerId })).body;
    const r1 = await c.req("PATCH", `/quotes/${q.id}`, {
      lockVersion: 0,
      lines: [{ description: "Labour", qty: "1.15", unit: "hour", unitPriceCents: 8500 }],
    });
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ lockVersion: 1, subtotalCents: 9775, taxCents: 1271, totalCents: 11046, totalsComplete: true });
    expect(r1.body.lines[0]).toMatchObject({ qty: "1.15", lineTotalCents: 9775, needsPrice: false });

    const stale = await c.req("PATCH", `/quotes/${q.id}`, { lockVersion: 0, terms: "x" });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: "STALE_QUOTE", details: { currentLockVersion: 1 } });
  });

  it("a line without a price makes totals incomplete, keeps the requested discount, and stores zeros", async () => {
    const q = (await c.req("POST", "/quotes", { customerId })).body;
    const r = await c.req("PATCH", `/quotes/${q.id}`, {
      lockVersion: 0, discountCents: 500,
      lines: [
        { description: "Priced", qty: "1", unit: "each", unitPriceCents: 10000 },
        { description: "Needs price", qty: "2", unit: "each", unitPriceCents: null },
      ],
    });
    expect(r.body).toMatchObject({ totalsComplete: false, totalCents: 0, discountCents: 0, requestedDiscountCents: 500 });
    expect(r.body.lines[1]).toMatchObject({ needsPrice: true, lineTotalCents: null });

    // Pricing the last line applies the remembered discount.
    const lines = r.body.lines.map((l: any) => ({ id: l.id, description: l.description, qty: l.qty, unit: l.unit, unitPriceCents: l.unitPriceCents ?? 2500 }));
    const done = await c.req("PATCH", `/quotes/${q.id}`, { lockVersion: r.body.lockVersion, lines });
    expect(done.body).toMatchObject({ totalsComplete: true, subtotalCents: 15000, discountCents: 500, taxCents: 1885, totalCents: 16385 });
  });

  it("rejects a discount bigger than the priced subtotal", async () => {
    const q = (await c.req("POST", "/quotes", { customerId })).body;
    const r = await c.req("PATCH", `/quotes/${q.id}`, { lockVersion: 0, discountCents: 101, lines: [{ description: "x", qty: "1", unit: "each", unitPriceCents: 100 }] });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("DISCOUNT_EXCEEDS_SUBTOTAL");
  });

  it("preview-totals computes without writing", async () => {
    const q = (await c.req("POST", "/quotes", { customerId })).body;
    const p = await c.req("POST", `/quotes/${q.id}/preview-totals`, {
      discountCents: 0, lines: [{ description: "a", qty: "2", unit: "each", unitPriceCents: 5000 }, { description: "b", qty: "1", unit: "each", unitPriceCents: null }],
    });
    expect(p.body).toMatchObject({ complete: false, unpricedLines: 1, subtotalCents: 10000, lineTotalsCents: [10000, null] });
    expect((await c.req("GET", `/quotes/${q.id}`)).body).toMatchObject({ lockVersion: 0, lines: [] });
  });

  it("rejects malformed quantities", async () => {
    const q = (await c.req("POST", "/quotes", { customerId })).body;
    const r = await c.req("PATCH", `/quotes/${q.id}`, { lockVersion: 0, lines: [{ description: "x", qty: "1.2345", unit: "each", unitPriceCents: 1 }] });
    expect(r.status).toBe(400);
  });
});

describe("Day 5 exit test", () => {
  it("a hand-built quote with an assembly, a discount and GST + QST totals correctly to the cent", async () => {
    const c = await signUpWithBusiness(t.app, "exit", "QC-GST-QST");
    const add = async (b: object) => (await c.req("POST", "/price-book", b)).body;
    const brk = await add({ kind: "material", name: "60 A breaker", unit: "each", costCents: 4815, markupPpm: 350_000 }); // → 6500
    const cable = await add({ kind: "material", name: "6/3 cable", unit: "foot", rateCents: 450 });
    const lab = await add({ kind: "labour", name: "Electrician", unit: "hour", rateCents: 9500 });
    const permit = await add({ kind: "fixed_job", name: "Permit", unit: "flat", rateCents: 12000 });
    const gfci = await add({ kind: "material", name: "GFCI", unit: "each", rateCents: 3995 });
    const asm = await add({
      kind: "assembly", name: "EV charger install", unit: "each",
      components: [{ componentId: brk.id, qty: "1" }, { componentId: cable.id, qty: "30" }, { componentId: lab.id, qty: "4" }, { componentId: permit.id, qty: "1" }],
    });
    expect(brk.rateCents).toBe(6500);

    const customer = (await c.req("POST", "/customers", { name: "François Lévesque", email: "f@example.com" })).body;
    let q = (await c.req("POST", "/quotes", { customerId: customer.id })).body;
    q = (await c.req("POST", `/quotes/${q.id}/lines/from-price-book`, { lockVersion: q.lockVersion, priceBookItemId: asm.id, qty: "1" })).body;
    expect(q.lines).toHaveLength(4);
    expect(new Set(q.lines.map((l: { groupKey: string }) => l.groupKey)).size).toBe(1);
    expect(q.lines.every((l: { sourceKind: string }) => l.sourceKind === "assembly")).toBe(true);

    q = (await c.req("POST", `/quotes/${q.id}/lines/from-price-book`, { lockVersion: q.lockVersion, priceBookItemId: gfci.id, qty: "3" })).body;
    const lines = q.lines.map((l: any) => ({ id: l.id, description: l.description, qty: l.qty, unit: l.unit, unitPriceCents: l.unitPriceCents, priceBookItemId: l.priceBookItemId, groupKey: l.groupKey }));
    lines.push({ description: "Surge protector (optional)", qty: "1", unit: "each", unitPriceCents: 24900, optional: true });
    q = (await c.req("PATCH", `/quotes/${q.id}`, { lockVersion: q.lockVersion, lines, discountCents: 5000 })).body;

    // By hand: 6500 + 30×450 + 4×9500 + 12000 + 3×3995 = 6500 + 13500 + 38000 + 12000 + 11985 = 81985
    // taxable = 81985 − 5000 = 76985
    // GST 5%     = 3849.25   → 3849
    // QST 9.975% = 7679.25… → 7679  (76985 × 0.09975 = 7679.25375)
    // total = 76985 + 3849 + 7679 = 88513
    expect(q).toMatchObject({
      subtotalCents: 81985, discountCents: 5000, taxCents: 11528, totalCents: 88513,
      optionalTotalCents: 24900, totalsComplete: true,
    });
    expect(q.taxes.map((x: { name: string; amountCents: number }) => [x.name, x.amountCents])).toEqual([["GST", 3849], ["QST", 7679]]);
  });
});
