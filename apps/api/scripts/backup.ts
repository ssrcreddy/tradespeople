// Off-host backups and restore test (design §8).
//
//   pnpm backup               dump Postgres to the backups bucket, prune past 14 days
//   pnpm backup:restore-test  restore the newest dump into a scratch database,
//                             boot the API against it, and compare row counts
//
// Runs pg_dump inside the db container, so host tools aren't needed. In
// production point S3_* at R2/S3 and run this nightly from the host's scheduler.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { S3Client, CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import pg from "pg";

const RETAIN_DAYS = 14;
const BUCKET = process.env.S3_BACKUP_BUCKET ?? "quotes-backups";
const DB = "quotes";
const SCRATCH = "quotes_restore_test";
const COMPOSE = ["compose", "-f", fileURLToPath(new URL("../../../infra/docker-compose.yml", import.meta.url))];

const s3 = new S3Client({
  ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true } : {}),
  region: "auto",
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "", secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "" },
});

function dbExec(args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn("docker", [...COMPOSE, "exec", "-T", "db", ...args], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    p.stdout.on("data", (b: Buffer) => out.push(b));
    p.stderr.on("data", (b: Buffer) => err.push(b));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${args[0]} exited ${code}: ${Buffer.concat(err)}`))));
    p.stdin.end(input);
  });
}

async function listDumps() {
  const r = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: "pg/" }));
  return (r.Contents ?? []).filter((o) => o.Key).sort((a, b) => a.Key!.localeCompare(b.Key!));
}

async function backup() {
  await s3.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(() => {});
  const dump = await dbExec(["pg_dump", "-U", "postgres", "-Fc", DB]);
  const key = `pg/${new Date().toISOString().replace(/[:.]/g, "-")}.dump`;
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: dump }));
  console.log(`backed up ${(dump.length / 1024).toFixed(0)} KB to ${BUCKET}/${key}`);

  const cutoff = Date.now() - RETAIN_DAYS * 86_400_000;
  for (const o of await listDumps()) {
    if (o.LastModified && o.LastModified.getTime() < cutoff) {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: o.Key! }));
      console.log(`pruned ${o.Key}`);
    }
  }
}

const TABLES = ["businesses", "customers", "price_book_items", "jobs", "quotes", "quote_lines", "invoices", "payments", "audit_events"];

async function counts(url: string) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const out: Record<string, number> = {};
  for (const t of TABLES) out[t] = (await c.query(`select count(*)::int as n from ${t}`)).rows[0].n;
  await c.end();
  return out;
}

async function restoreTest() {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl) throw new Error("DATABASE_ADMIN_URL is required");
  const latest = (await listDumps()).at(-1);
  if (!latest) throw new Error(`no backups in ${BUCKET}`);
  const body = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: latest.Key! }));
  const dump = Buffer.from(await body.Body!.transformToByteArray());
  console.log(`restoring ${latest.Key} (${(dump.length / 1024).toFixed(0)} KB)`);

  await dbExec(["psql", "-U", "postgres", "-c", `DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`]);
  await dbExec(["psql", "-U", "postgres", "-c", `CREATE DATABASE ${SCRATCH}`]);
  await dbExec(["pg_restore", "-U", "postgres", "-d", SCRATCH, "--no-owner", "--role=postgres", "--exit-on-error"], dump);

  const scratchAdmin = new URL(adminUrl);
  scratchAdmin.pathname = `/${SCRATCH}`;
  const before = await counts(adminUrl);
  const after = await counts(scratchAdmin.toString());
  const same = TABLES.every((t) => before[t]! >= after[t]!) && after.businesses! > 0;
  console.log("live     ", JSON.stringify(before));
  console.log("restored ", JSON.stringify(after));

  // Boot the real API on the restored data and ask it if it's healthy.
  const appUrl = new URL(process.env.DATABASE_URL!);
  appUrl.pathname = `/${SCRATCH}`;
  const port = "8099";
  const server = spawn(process.execPath, [fileURLToPath(new URL("../src/server.ts", import.meta.url))], {
    env: { ...process.env, DATABASE_URL: appUrl.toString(), PORT: port }, stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  server.stderr.on("data", (b: Buffer) => { stderr += b; });
  let health: unknown = null;
  try {
    for (let i = 0; i < 360 && !health && server.exitCode === null; i++) {
      await new Promise((r) => setTimeout(r, 500));
      health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()).catch(() => null);
    }
  } finally {
    server.kill();
  }
  await dbExec(["psql", "-U", "postgres", "-c", `DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`]);
  console.log("health   ", JSON.stringify(health));
  if (!health && stderr) console.error(stderr.slice(-2000));
  // A restored queue may hold old jobs with no worker, so health may report a
  // backlog; the test is that the app boots and answers against the restored data.
  if (!same || typeof (health as { queueDepth?: unknown } | null)?.queueDepth !== "number") throw new Error("restore test FAILED");
  console.log("restore test passed");
}

await (process.argv[2] === "restore-test" ? restoreTest() : backup());
