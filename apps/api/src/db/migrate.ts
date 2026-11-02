// One-shot migration step (design §8): runs before api/worker start, as the
// privileged role. Ensures the non-owner "app" role exists first, because the
// RLS migration grants to it. Roles are cluster-wide, so this is idempotent.
import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

export async function runMigrations(adminUrl: string, appPassword: string) {
  const pool = new pg.Pool({ connectionString: adminUrl, max: 1 });
  try {
    const exists = await pool.query("SELECT 1 FROM pg_roles WHERE rolname = 'app'");
    const pw = appPassword.replaceAll("'", "''");
    if (exists.rowCount === 0) {
      await pool.query(`CREATE ROLE app LOGIN PASSWORD '${pw}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    } else {
      await pool.query(`ALTER ROLE app LOGIN PASSWORD '${pw}' NOSUPERUSER NOBYPASSRLS`);
    }
    await migrate(drizzle(pool), { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("migrate.ts")) {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl) throw new Error("DATABASE_ADMIN_URL is required");
  await runMigrations(adminUrl, process.env.APP_DB_PASSWORD ?? "app");
  console.log("migrations applied");
}
