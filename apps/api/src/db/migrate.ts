// One-shot migration step (design §8): runs before api/worker start, as the
// privileged role. Ensures the non-owner "app" role exists first, because the
// RLS migration grants to it. Roles are cluster-wide, so this is idempotent.
import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { installQueue, SCHEMA } from "../queue.ts";

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

    // Job queue schema: installed by the admin role, used by the app role.
    await installQueue(adminUrl);
    await pool.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO app`);
    await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${SCHEMA} TO app`);
    await pool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${SCHEMA} TO app`);
    await pool.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${SCHEMA} TO app`);
    await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${SCHEMA} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app`);
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
