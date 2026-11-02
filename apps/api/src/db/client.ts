import pg from "pg";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.ts";

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function createDb(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 10 });
  return { pool, db: drizzle(pool, { schema }) };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Every tenant data access runs inside this (design §11 tenancy rule): one
// transaction with app.business_id set LOCAL, so RLS applies to every
// statement and the setting cannot leak to the next user of the connection.
export async function withTenant<T>(db: Db, businessId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID.test(businessId)) throw new Error("withTenant: businessId must be a uuid");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.business_id', ${businessId}, true)`);
    return fn(tx);
  });
}
