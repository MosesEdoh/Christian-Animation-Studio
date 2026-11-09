import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import express from "express";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { clerkSession } from "./helpers/clerkSession";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost/unused";
const { db } = await import("@workspace/db");
const { requireStudioAccess } = await import("../src/middlewares/studioAccess");
const dialect = new PgDialect();
let rows: Array<{ id: string; email?: string; firstName?: string }>;
let lookups: string[];
let inserts: unknown[];
let race: boolean;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.STUDIO_ALLOWED_EMAILS;
  process.env.STUDIO_ALLOWED_EMAILS = "approved@example.test";
  rows = []; lookups = []; inserts = []; race = false;
  mock.method(db, "select", () => ({
    from: () => ({ where: (predicate: SQL) => {
      const id = dialect.sqlToQuery(predicate).params[0] as string;
      lookups.push(id);
      return { limit: async () => rows.filter(row => row.id === id) };
    } }),
  }));
  mock.method(db, "insert", () => ({
    values: (value: { id: string }) => {
      inserts.push(value); rows.push(value);
      return { onConflictDoNothing: () => ({ returning: async () => race ? [] : [value] }) };
    },
  }));
});
afterEach(() => {
  mock.restoreAll();
  if (saved === undefined) delete process.env.STUDIO_ALLOWED_EMAILS;
  else process.env.STUDIO_ALLOWED_EMAILS = saved;
});
async function request(claims: Record<string, unknown> | null, nativeId = "user_clerk") {
  const app = express();
  app.use((req, _res, next) => {
    Object.assign(req, clerkSession(claims, nativeId));
    next();
  });
  app.get("/", requireStudioAccess, (req, res) => res.json({ id: req.dbUser?.id }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  try { return await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/`); }
  finally { await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())); }
}
test("migrated users resolve their legacy local row, never the Clerk native ID", async () => {
  rows = [{ id: "legacy-subject", email: "old@example.test", firstName: "Original" }];
  const response = await request({ userId: "legacy-subject", email: "approved@example.test" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: "legacy-subject" });
  assert.deepEqual(lookups, ["legacy-subject"]);
  assert.deepEqual(inserts, []);
  assert.equal(rows[0].firstName, "Original");
});
test("new accounts provision only the ID and reuse their local row on subsequent requests", async () => {
  const claims = { userId: "user_new", email: "approved@example.test", firstName: "New" };
  assert.equal((await request(claims, "user_new")).status, 200);
  assert.equal((await request(claims, "user_new")).status, 200);
  assert.deepEqual(inserts, [{ id: "user_new" }]);
});
test("concurrent first-request inserts reload the winning row", async () => {
  race = true;
  const response = await request({ userId: "new-subject", email: "approved@example.test" });
  assert.equal(response.status, 200);
  assert.deepEqual(lookups, ["new-subject", "new-subject"]);
});
test("signed-out, unapproved, unverified and missing-bridge sessions fail closed without provisioning", async () => {
  assert.equal((await request(null)).status, 401);
  assert.equal((await request({ userId: "unapproved", email: "no@example.test" })).status, 403);
  assert.equal((await request({ userId: "unverified", email: "approved@example.test", email_verified: false })).status, 403);
  assert.equal((await request({ email: "approved@example.test" })).status, 401);
  assert.deepEqual(inserts, []);
  assert.deepEqual(lookups, []);
});
