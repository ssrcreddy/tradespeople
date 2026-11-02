// Creates a fresh test database, migrates it, and hands the URLs to the tests.
import pg from "pg";
import type { TestProject } from "vitest/node";
import { runMigrations } from "../../src/db/migrate.ts";

const ADMIN = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://postgres:postgres@localhost:56432/postgres";
const APP_PASSWORD = process.env.APP_DB_PASSWORD ?? "app";
const DB = "quotes_test";

function withDb(url: string, db: string) {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

export default async function setup(project: TestProject) {
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB}`);
  await admin.end();

  const adminUrl = withDb(ADMIN, DB);
  await runMigrations(adminUrl, APP_PASSWORD);

  const appUrl = new URL(adminUrl);
  appUrl.username = "app";
  appUrl.password = APP_PASSWORD;
  project.provide("adminUrl", adminUrl);
  project.provide("appUrl", appUrl.toString());
}

declare module "vitest" {
  export interface ProvidedContext {
    adminUrl: string;
    appUrl: string;
  }
}
