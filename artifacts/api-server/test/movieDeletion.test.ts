import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import express from "express";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { clerkSession } from "./helpers/clerkSession";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost/unused";
const { db, studioExportsTable, usersTable } = await import("@workspace/db");
const { default: routes } = await import("../src/routes/index");
const { ObjectStorageService, ObjectNotFoundError } = await import("../src/lib/objectStorage");
type Row = typeof studioExportsTable.$inferSelect;
let rows: Row[];
let events: string[];
let storageError: unknown;
let databaseError: boolean;
let signedIn: boolean;
let approved: boolean;
const dialect = new PgDialect();
const job = (id: number, status: Row["status"], objectPath: string | null = "/objects/movie.mp4"): Row => ({
  id, status, objectPath, episodeId: 1, aspectRatio: "16:9", quality: "720p",
  progress: 100, error: null, startedAt: null, createdAt: new Date(),
});
function matches(row: Row, predicate: SQL) {
  const { params } = dialect.sqlToQuery(predicate);
  return row.id === params[0] && (params.length === 1 || params.slice(1).includes(row.status));
}
beforeEach(() => {
  rows = [job(1, "ready")];
  events = [];
  storageError = undefined;
  databaseError = false;
  signedIn = approved = true;
  mock.method(db, "select", () => ({
    from: (table: unknown) => table === usersTable
      ? { where: () => ({ limit: async () => [{ id: "creator" }] }) }
      : { where: async (predicate: SQL) => rows.filter(row => matches(row, predicate)) },
  }));
  mock.method(db, "delete", () => ({
    where: async (predicate: SQL) => {
      events.push("history");
      if (databaseError) throw new Error("Database unavailable");
      rows = rows.filter(row => !matches(row, predicate));
    },
  }));
  mock.method(ObjectStorageService.prototype, "getObjectEntityFile", async () => {
    events.push("lookup");
    if (storageError) throw storageError;
    return { delete: async (options: unknown) => {
      assert.deepEqual(options, { ignoreNotFound: true });
      events.push("object");
    } };
  });
});
afterEach(() => mock.restoreAll());

async function request(id: string) {
  const app = express();
  // Exercise the real parent router's protection, not a test-only route guard.
  app.use((req, _res, next) => {
    Object.assign(req, clerkSession(signedIn ? { userId: "creator", email: approved ? "allowed@example.test" : "denied@example.test" } : null));
    req.log = { error() {} } as typeof req.log;
    next();
  });
  const saved = process.env.STUDIO_ALLOWED_EMAILS;
  process.env.STUDIO_ALLOWED_EMAILS = "allowed@example.test";
  app.use("/api", routes);
  app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: "Database unavailable" });
  });
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address() as { port: number };
    return await fetch(`http://127.0.0.1:${address.port}/api/studio/exports/${id}`, { method: "DELETE" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (saved === undefined) delete process.env.STUDIO_ALLOWED_EMAILS;
    else process.env.STUDIO_ALLOWED_EMAILS = saved;
  }
}

test("deletes the object before history, and repeated deletion is a successful no-op", async () => {
  assert.equal((await request("1")).status, 204);
  assert.deepEqual(events, ["lookup", "object", "history"]);
  assert.deepEqual(rows, []);
  assert.equal((await request("1")).status, 204);
  assert.deepEqual(events, ["lookup", "object", "history"]);
});
for (const status of ["queued", "rendering"] as const) {
  test(`rejects ${status} movies without touching storage or history`, async () => {
    rows = [job(1, status)];
    assert.equal((await request("1")).status, 409);
    assert.deepEqual(events, []);
    assert.equal(rows.length, 1);
  });
}
for (const status of ["failed", "cancelled"] as const) {
  test(`removes ${status} history without requiring a stored file`, async () => {
    rows = [job(1, status, null)];
    assert.equal((await request("1")).status, 204);
    assert.deepEqual(events, ["history"]);
    assert.deepEqual(rows, []);
  });
}
test("an already missing object still permits history deletion", async () => {
  storageError = new ObjectNotFoundError();
  assert.equal((await request("1")).status, 204);
  assert.deepEqual(rows, []);
});
test("a concurrent object removal is a successful deletion", async () => {
  mock.method(ObjectStorageService.prototype, "getObjectEntityFile", async () => ({
    delete: async () => { throw { code: 404 }; },
  }));
  assert.equal((await request("1")).status, 204);
  assert.deepEqual(rows, []);
});
test("storage permission and service errors retain history and allow retry", async () => {
  for (const code of [403, 500]) {
    storageError = { code };
    assert.equal((await request("1")).status, 503);
    assert.equal(rows.length, 1);
    assert.ok(!events.includes("history"));
  }
  storageError = undefined;
  assert.equal((await request("1")).status, 204);
  assert.deepEqual(rows, []);
});
test("a database failure after object removal can be retried with a missing object", async () => {
  databaseError = true;
  assert.equal((await request("1")).status, 500);
  assert.equal(rows.length, 1);
  assert.deepEqual(events, ["lookup", "object", "history"]);
  databaseError = false;
  storageError = new ObjectNotFoundError();
  assert.equal((await request("1")).status, 204);
  assert.deepEqual(rows, []);
});
test("invalid IDs cannot delete anything", async () => {
  for (const id of ["bad", "0", "-1", "1.5"]) assert.equal((await request(id)).status, 400);
  assert.equal(rows.length, 1);
  assert.deepEqual(events, []);
});
test("anonymous and unapproved callers cannot delete movies, even missing ones", async () => {
  signedIn = false;
  assert.equal((await request("1")).status, 401);
  signedIn = true;
  approved = false;
  assert.equal((await request("1")).status, 403);
  assert.equal((await request("999")).status, 403);
  assert.deepEqual(events, []);
  assert.equal(rows.length, 1);
});
