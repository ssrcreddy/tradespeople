// Golden-set evaluation (design §24). Runs every case through the real
// pipeline — job creation, the extraction job, the matcher — against the real
// model, N times each, and writes a dated report.
//
//   pnpm eval                 (needs OPENAI_API_KEY + STRONG_MODEL + the dev DB)
//   pnpm eval -- --repeats 1 --only 03-injection
//   pnpm eval -- --fake       (plumbing check: a model that only asks questions)
//
// Uses a throwaway business (electrical starter pack with sample rates) that
// is deleted at the end.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import pg from "pg";
import { loadConfig } from "../src/config.ts";
import { createDb } from "../src/db/client.ts";
import { createBoss, Q } from "../src/queue.ts";
import { memoryStore } from "../src/storage.ts";
import { memoryMailer } from "../src/mail.ts";
import { noPush } from "../src/push.ts";
import { openAiProvider, scriptedProvider } from "../src/llm/gateway.ts";
import { createBusiness } from "../src/services/businesses.ts";
import { loadStarter } from "../src/services/priceBook.ts";
import { createManualJob } from "../src/services/intake.ts";
import { extract } from "../src/jobs/extract.ts";
import type { WorkerDeps } from "../src/jobs/deps.ts";
import type { TenantCtx } from "../src/http/context.ts";

interface Case {
  id: string; source: "paste" | "site_notes"; text: string; hoursStated?: boolean;
  expect: { outcome: string; customerEmail?: string; lines?: string[]; allow?: string[]; mustAsk?: boolean; forbidDescriptions?: string[]; noMatchedLines?: boolean };
}

const { values: args } = parseArgs({ options: { repeats: { type: "string", default: "3" }, only: { type: "string" }, fake: { type: "boolean", default: false } } });
const REPEATS = Number(args.repeats);

// Sample rates so matched lines are priced; names are starter-pack prefixes.
const SAMPLE_RATES: Record<string, number> = {
  "Electrician labour": 9500, "Apprentice labour": 5500, "Service call": 12900, "Electrical permit": 18000,
  "GFCI receptacle": 3995, "Tamper-resistant receptacle": 1495, "Weatherproof GFCI": 6500, "LED pot light": 2800,
  "Single-pole switch": 995, "LED dimmer": 4500, "Hardwired smoke/CO alarm": 8900, "Breaker, 15 A": 1800,
  "Breaker, 40 A": 4200, "Breaker, 60 A": 6500, "Cable, NMD90 14/2": 120, "Cable, NMD90 6/3": 450,
  "Whole-home surge protector": 32000, "200 A panel": 145000, "Install customer-supplied light fixture": 9500,
};

const cfg = loadConfig();
if (!cfg.openai && !args.fake) {
  console.error("eval needs OPENAI_API_KEY and STRONG_MODEL (an exact snapshot ID) in .env");
  process.exit(1);
}
const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl) { console.error("eval needs DATABASE_ADMIN_URL"); process.exit(1); }

const golden = JSON.parse(await readFile(new URL("../../../data/golden/enquiries.json", import.meta.url), "utf8")) as { cases: Case[] };
const cases = golden.cases.filter((c) => !args.only || c.id === args.only);

const { db, pool } = createDb(cfg.databaseUrl);
const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
const boss = createBoss(cfg.databaseUrl, { worker: false });
boss.on("error", () => {});
await boss.start();
const store = memoryStore();
const llm = args.fake || !cfg.openai
  ? scriptedProvider(() => ({ isEnquiry: true, customer: { name: null, email: null, phone: null, siteAddress: null }, jobType: "x", summary: "x", urgency: "unknown", lines: [], questions: ["(fake model)"] }), "fake")
  : openAiProvider(cfg.openai);
const deps: WorkerDeps = {
  db, pool, boss, store, llm, mailer: memoryMailer(), push: noPush, adminDatabaseUrl: adminUrl, pricing: cfg.pricing, webOrigin: cfg.webOrigin,
  llmMonthlyCapUsd: 1_000_000, inbound: { verify: () => null, verifyDelivery: () => null, fetch: async () => { throw new Error("n/a"); } },
};

// Throwaway tenant with the starter pack and sample rates.
const userId = `eval_${randomUUID()}`;
await admin.query(`insert into "user"(id, name, email) values ($1, 'Eval', $2)`, [userId, `${userId}@eval.local`]);
const biz = await createBusiness(db, pool, { userId, email: `${userId}@eval.local` }, { name: `Eval ${new Date().toISOString()}`, taxPreset: "ON-HST" });
const t: TenantCtx = { userId, email: `${userId}@eval.local`, businessId: biz.id, role: "owner" };
await loadStarter(db, t);
for (const [prefix, cents] of Object.entries(SAMPLE_RATES)) {
  await admin.query(`update price_book_items set rate_cents = $1 where business_id = $2 and name like $3 and kind <> 'assembly'`, [cents, biz.id, `${prefix}%`]);
}

interface Run {
  caseId: string; repeat: number; pass: boolean; outcome: string; failures: string[];
  expected: number; missing: number; falsePrices: number; labourPlaceholders: number; inventedHours: number; retried: boolean; costUsd: number;
  // What the model said and what the matcher did with it, for diagnosing failures.
  detail: { extracted: unknown; lines: { description: string; qty: number; item: string | null; group: string | null }[]; questions: string[] };
}

const matchesAny = (name: string | null, pattern: string) => !!name && pattern.split("|").some((p) => name.startsWith(p));

const runs: Run[] = [];
for (const c of cases) {
  for (let r = 1; r <= REPEATS; r++) {
    const job = await createManualJob(db, boss, store, t, { text: c.text, source: c.source, files: [] });
    await boss.deleteAllJobs(Q.extract);          // we run the handler directly
    const res = await extract(deps, { businessId: biz.id, jobId: job.id });

    const { rows: [j] } = await admin.query(`select status, extraction from jobs where id = $1`, [job.id]);
    const { rows: lines } = await admin.query(
      `select l.description, l.qty_milli, l.unit, l.price_book_item_id, l.source_kind, l.group_key, l.qty_to_confirm, p.name as item_name, p.kind as item_kind
         from quote_lines l join quotes q on q.id = l.quote_id left join price_book_items p on p.id = l.price_book_item_id
        where q.job_id = $1 order by l.sort`, [job.id]);
    const { rows: [cust] } = await admin.query(
      `select c.email from jobs j left join customers c on c.id = j.customer_id where j.id = $1`, [job.id]);
    const { rows: [calls] } = await admin.query(`select count(*)::int as n, coalesce(sum(cost_usd), 0)::float as cost from llm_calls where job_id = $1`, [job.id]);

    const outcome = res.outcome === "not_a_job" ? "not_a_job" : j.status;
    const failures: string[] = [];
    if (!c.expect.outcome.split("|").includes(outcome)) failures.push(`outcome ${outcome}`);
    if (c.expect.customerEmail && cust?.email !== c.expect.customerEmail) failures.push(`customer email ${cust?.email ?? "none"}`);

    // A line "covers" an expected pattern via its item name or its assembly group name.
    const covered = (pattern: string) => lines.some((l) => matchesAny(l.item_name, pattern) || matchesAny(l.group_key?.split(":").slice(1).join(":") ?? null, pattern));
    const expected = c.expect.lines ?? [];
    const missing = outcome === "draft_ready" ? expected.filter((p) => !covered(p)) : [];
    if (missing.length) failures.push(`missing ${missing.join(", ")}`);

    // Prompt rule 6: unstated hours become 1 hour, flagged "to confirm" on the
    // review screen. The item is right and the quantity is a labelled
    // placeholder, so these are counted on their own, not as false prices.
    const placeholder = (l: (typeof lines)[number]) =>
      l.item_kind === "labour" && l.source_kind !== "assembly" && l.qty_milli === 1000 && l.qty_to_confirm;
    const labourPlaceholders = lines.filter(placeholder);
    const okPatterns = [...expected, ...(c.expect.allow ?? [])];
    const fits = (l: (typeof lines)[number]) => okPatterns.some((p) =>
      matchesAny(l.item_name, p) || matchesAny(l.group_key?.split(":").slice(1).join(":") ?? null, p));
    // An assembly counts as a whole: if one part fits, its labour and cable do too.
    const fitGroups = new Set(lines.filter((l) => l.group_key && fits(l)).map((l) => l.group_key));
    const falsePriced = lines.filter((l) => l.price_book_item_id && !placeholder(l) && !fits(l) && !fitGroups.has(l.group_key));
    if (falsePriced.length) failures.push(`unexpected matches ${falsePriced.map((l) => l.item_name).join(", ")}`);
    if (c.expect.noMatchedLines && lines.some((l) => l.price_book_item_id)) failures.push("matched lines for an out-of-trade job");

    const invented = c.hoursStated ? [] : lines.filter((l) => l.unit === "hour" && l.qty_milli !== 1000 && l.source_kind !== "assembly");
    if (invented.length) failures.push(`invented hours on ${invented.map((l) => l.description).join(", ")}`);

    const questions = (j.extraction?.questions ?? []) as string[];
    if (c.expect.mustAsk && questions.length === 0) failures.push("did not ask");
    for (const w of c.expect.forbidDescriptions ?? []) {
      if (lines.some((l) => l.description.toLowerCase().includes(w))) failures.push(`forbidden line "${w}"`);
    }

    runs.push({
      caseId: c.id, repeat: r, pass: failures.length === 0, outcome, failures,
      expected: expected.length, missing: missing.length, falsePrices: falsePriced.length, labourPlaceholders: labourPlaceholders.length, inventedHours: invented.length,
      retried: calls.n > 1, costUsd: calls.cost,
      detail: {
        extracted: j.extraction?.lines ?? [], questions,
        lines: lines.map((l) => ({ description: l.description, qty: l.qty_milli / 1000, item: l.item_name, group: l.group_key })),
      },
    });
    console.log(`${failures.length ? "FAIL" : "pass"} ${c.id} #${r} ${outcome}${failures.length ? " — " + failures.join("; ") : ""}`);
  }
}

// ---------- report ----------
const byCase = new Map<string, Run[]>();
for (const r of runs) byCase.set(r.caseId, [...(byCase.get(r.caseId) ?? []), r]);
const casePass = [...byCase.values()].filter((rs) => rs.every((r) => r.pass)).length;
const disagreements = [...byCase.values()].filter((rs) => new Set(rs.map((r) => r.pass)).size > 1).length;
const sum = (f: (r: Run) => number) => runs.reduce((a, r) => a + f(r), 0);
const drafts = runs.filter((r) => r.outcome === "draft_ready");
const metrics = {
  model: llm.model, cases: byCase.size, repeats: REPEATS, runs: runs.length,
  casesPassingAllRepeats: casePass,
  missRate: sum((r) => r.expected) ? sum((r) => r.missing) / sum((r) => r.expected) : 0,
  falsePrices: sum((r) => r.falsePrices),
  labourPlaceholders: sum((r) => r.labourPlaceholders),
  inventedHours: sum((r) => r.inventedHours),
  validWithoutRetry: runs.filter((r) => !r.retried).length / runs.length,
  runToRunDisagreements: disagreements,
  costPerDraftUsd: drafts.length ? drafts.reduce((a, r) => a + r.costUsd, 0) / drafts.length : 0,
};

const date = new Date().toISOString().slice(0, 10);
const dir = new URL("../../../data/golden/reports/", import.meta.url);
await mkdir(dir, { recursive: true });
const md = [
  `# Eval report ${date}`, "",
  `Model \`${metrics.model}\` · ${metrics.cases} cases × ${REPEATS} repeats · prompt electrical.extract.v1`, "",
  "| Metric | Value | Gate |", "|---|---|---|",
  `| Cases passing every repeat | ${casePass}/${metrics.cases} | — |`,
  `| Miss rate | ${(metrics.missRate * 100).toFixed(1)}% | ≤10% |`,
  `| False prices | ${metrics.falsePrices} | 0 |`,
  `| Labour placeholders (1 h, flagged to confirm) | ${metrics.labourPlaceholders} | report |`,
  `| Invented hours | ${metrics.inventedHours} | 0 |`,
  `| Valid without retry | ${(metrics.validWithoutRetry * 100).toFixed(0)}% | ≥90% |`,
  `| Run-to-run disagreements | ${disagreements} | report |`,
  `| Cost per draft | $${metrics.costPerDraftUsd.toFixed(4)} | ≪ $0.50 |`, "",
  "| Case | Result | Failures |", "|---|---|---|",
  ...[...byCase.entries()].map(([id, rs]) => `| ${id} | ${rs.filter((r) => r.pass).length}/${rs.length} | ${[...new Set(rs.flatMap((r) => r.failures))].join("; ") || "—"} |`),
  "", `With ${metrics.cases} cases, "0 false prices" is weak evidence — grow the set from pilot data (§24).`,
].join("\n");
const stem = `eval-${date}-${metrics.model.replace(/[^\w.-]+/g, "_")}`;
await writeFile(new URL(`${stem}.md`, dir), md);
await writeFile(new URL(`${stem}.json`, dir), JSON.stringify({ metrics, runs }, null, 2));
console.log("\n" + md);

await admin.query(`delete from businesses where id = $1`, [biz.id]);
await admin.query(`delete from "user" where id = $1`, [userId]);
await boss.stop({ graceful: false });
await pool.end();
await admin.end();
process.exit(metrics.falsePrices === 0 && metrics.inventedHours === 0 ? 0 : 1);
