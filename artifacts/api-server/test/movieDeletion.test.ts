import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import express from "express";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { hashTrustedDeviceToken } from "../src/lib/trustedDevice";
import { clerkSession } from "./helpers/clerkSession";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost/unused";
const { db, studioExportsTable, studioTrustedDevicesTable, usersTable } = await import("@workspace/db");
const { default: routes } = await import("../src/routes/index");
const { ObjectStorageService, ObjectNotFoundError } = await import("../src/lib/objectStorage");
type Row = typeof studioExportsTable.$inferSelect;
let rows: Row[];
let events: string[];
let storageError: unknown;
let databaseError: boolean;
let signedIn: boolean;
let trustedDevice: boolean;
const dialect = new PgDialect();
const deviceToken = "c".repeat(43);
const deviceTokenHash = hashTrustedDeviceToken(deviceToken);
const job = (id: number, status: Row["status"], objectPath: string | null = "/objects/movie.mp4"): Row => ({
  id, requestId: null, status, objectPath, episodeId: 1, aspectRatio: "16:9", quality: "720p",
  progress: 100, sizeBytes: null, error: null, startedAt: null, createdAt: new Date(),
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
  signedIn = trustedDevice = true;
  mock.method(db, "select", (selection?: Record<string, SQL>) => ({
    from: (table: unknown) => table === usersTable
      ? { where: () => ({ limit: async () => [{ id: "creator" }] }) }
      : table === studioTrustedDevicesTable
        ? { where: (predicate: SQL) => ({
            limit: async () => dialect.sqlToQuery(predicate).params[0] === deviceTokenHash ? [{ id: 1 }] : [],
          }) }
        : { where: (predicate?: SQL) => {
        if (selection?.knownSizeBytes) {
          assert.ok(predicate);
          const filter = dialect.sqlToQuery(predicate);
          assert.deepEqual(filter.params, ["ready"]);
          assert.match(filter.sql, /"object_path" is not null/);
          assert.match(dialect.sqlToQuery(selection.knownSizeBytes).sql, /coalesce\(sum\(.+\) filter \(where .+ between 0 and 9007199254740991\), 0\)/);
          assert.match(dialect.sqlToQuery(selection.savedMovieCount).sql, /count\(\*\)/);
          assert.match(dialect.sqlToQuery(selection.unknownSizeCount).sql, /is null or not/);
          const saved = rows.filter(row => row.status === "ready" && row.objectPath !== null);
          const known = saved.filter(row => row.sizeBytes !== null && Number.isSafeInteger(row.sizeBytes) && row.sizeBytes >= 0);
          return Promise.resolve([{
            knownSizeBytes: known.reduce((total, row) => total + row.sizeBytes!, 0),
            savedMovieCount: saved.length,
            unknownSizeCount: saved.length - known.length,
          }]);
        }
        const query = predicate ? dialect.sqlToQuery(predicate) : undefined;
        if (!query || query.sql.includes(" < ")) {
          const page = rows.filter(row => !query || row.id < Number(query.params[0])).sort((a, b) => b.id - a.id);
          return { orderBy: () => ({ limit: async (limit: number) => page.slice(0, limit) }) };
        }
        return Promise.resolve(rows.filter(row => matches(row, predicate!)));
      } },
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

test("storage totals span all pages and distinguish unknown sizes from zero", async () => {
  rows = Array.from({ length: 205 }, (_, i) => ({ ...job(i + 1, "ready"), sizeBytes: 3_000_000_000 }));
  rows[0].sizeBytes = null; // Outside the first two pages.
  rows[1].sizeBytes = 0;
  rows.push(job(206, "queued", null), job(207, "rendering", null), job(208, "failed", null),
    job(209, "cancelled", null), job(210, "ready", null));
  assert.equal((await (await request("?limit=100", "GET")).json()).length, 100);
  assert.deepEqual(await (await request("storage", "GET")).json(), {
    knownSizeBytes: 203 * 3_000_000_000, savedMovieCount: 205, unknownSizeCount: 1,
  });
  assert.equal((await request("3")).status, 204);
  assert.deepEqual(await (await request("storage", "GET")).json(), {
    knownSizeBytes: 202 * 3_000_000_000, savedMovieCount: 204, unknownSizeCount: 1,
  });
  assert.equal((await request("1")).status, 204);
  assert.deepEqual(await (await request("storage", "GET")).json(), {
    knownSizeBytes: 202 * 3_000_000_000, savedMovieCount: 203, unknownSizeCount: 0,
  });
});

test("storage handles empty history, all unknown sizes, invalid sizes, and completed renders", async () => {
  rows = [];
  assert.deepEqual(await (await request("storage", "GET")).json(), {
    knownSizeBytes: 0, savedMovieCount: 0, unknownSizeCount: 0,
  });
  rows = [job(1, "ready"), { ...job(2, "ready"), sizeBytes: -1 }, job(3, "rendering", null)];
  assert.deepEqual(await (await request("storage", "GET")).json(), {
    knownSizeBytes: 0, savedMovieCount: 2, unknownSizeCount: 2,
  });
  rows[2] = { ...job(3, "ready"), sizeBytes: 1_234_567 };
  assert.deepEqual(await (await request("storage", "GET")).json(), {
    knownSizeBytes: 1_234_567, savedMovieCount: 3, unknownSizeCount: 2,
  });
});

test("storage summary requires sign-in and a trusted studio device", async () => {
  signedIn = false;
  assert.equal((await request("storage", "GET")).status, 401);
  signedIn = true;
  trustedDevice = false;
  assert.equal((await request("storage", "GET")).status, 403);
});

test("movie history exposes known sizes and explicit null for historical exports, then removes deleted sizes", async () => {
  rows = [{ ...job(2, "ready"), sizeBytes: 3_000_000_000 }, job(1, "ready")];
  const history = await (await request("?limit=100", "GET")).json();
  assert.deepEqual(history.map((row: Row) => row.sizeBytes), [3_000_000_000, null]);
  assert.equal((await request("2")).status, 204);
  const remaining = await (await request("?limit=100", "GET")).json();
  assert.deepEqual(remaining.map((row: Row) => [row.id, row.sizeBytes]), [[1, null]]);
});

async function request(id: string, method = "DELETE") {
  const app = express();
  // Exercise the real parent router's protection, not a test-only route guard.
  app.use((req, _res, next) => {
    Object.assign(req, clerkSession(signedIn ? { userId: "creator", email: "any@example.test" } : null));
    if (trustedDevice) req.headers["x-studio-device"] = deviceToken;
    req.log = { error() {} } as typeof req.log;
    next();
  });
  app.use("/api", routes);
  app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: "Database unavailable" });
  });
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address() as { port: number };
    return await fetch(`http://127.0.0.1:${address.port}/api/studio/exports${id.startsWith("?") ? id : `/${id}`}`, { method });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test("pages beyond one hundred and deletes an older movie without skipping history", async () => {
  rows = Array.from({ length: 205 }, (_, index) => job(index + 1, "ready", null));
  const first = await (await request("?limit=100", "GET")).json();
  assert.equal(first.length, 100);
  assert.deepEqual(first.map((row: Row) => row.id), Array.from({ length: 100 }, (_, i) => 205 - i));
  const older = await (await request("?beforeId=106", "GET")).json();
  assert.equal(older.length, 100);
  assert.equal(older[0].id, 105);
  assert.equal(older[99].id, 6);
  // Delete the page-boundary movie: its cursor must still reach the final five.
  assert.equal((await request("6")).status, 204);
  const last = await (await request("?beforeId=6", "GET")).json();
  assert.deepEqual(last.map((row: Row) => row.id), [5, 4, 3, 2, 1]);
  assert.equal(rows.length, 204);
  assert.equal(rows.some(row => row.id === 205), true);
  assert.equal(rows.some(row => row.id === 6), false);
  assert.deepEqual(await (await request("?beforeId=1", "GET")).json(), []);
  assert.equal((await (await request("?limit=2", "GET")).json()).length, 2);
});

test("rejects invalid page sizes and cursors", async () => {
  for (const query of ["limit=0", "limit=101", "limit=1.5", "limit=bad", "beforeId=0", "beforeId=-1", "beforeId=1.5", "beforeId=2147483648", "beforeId=bad", "beforeId=1&beforeId=2"]) {
    assert.equal((await request(`?${query}`, "GET")).status, 400, query);
  }
});

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
test("anonymous and untrusted devices cannot delete movies, even missing ones", async () => {
  signedIn = false;
  assert.equal((await request("1")).status, 401);
  signedIn = true;
  trustedDevice = false;
  assert.equal((await request("1")).status, 403);
  assert.equal((await request("999")).status, 403);
  assert.deepEqual(events, []);
  assert.equal(rows.length, 1);
});
