import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

// Isolate background work from interactive requests. Both the server statement
// and the client/socket wait are bounded; a Promise timeout alone cannot do this.
export function createBoundedDatabase() {
  return drizzle(new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    query_timeout: 6000,
    idleTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  }), { schema });
}

export * from "./schema";
