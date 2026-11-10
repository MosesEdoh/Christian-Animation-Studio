import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import express from "express";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { hashTrustedDeviceToken } from "../src/lib/trustedDevice";
import { clerkSession } from "./helpers/clerkSession";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost/unused";
const {
  childProfilesTable,
  db,
  studioTrustedDevicesTable,
  usersTable,
} = await import("@workspace/db");
const { default: routes } = await import("../src/routes/index");
type Profile = typeof childProfilesTable.$inferSelect;

const dialect = new PgDialect();
const deviceToken = "c".repeat(43);
const deviceTokenHash = hashTrustedDeviceToken(deviceToken);
let rows: Profile[];
let nextId: number;
let actor = "guardian-a";
let signedIn = true;
let trusted = true;

function profile(id: number, guardianUserId: string): Profile {
  const now = new Date("2026-11-10T12:00:00.000Z");
  return {
    id,
    guardianUserId,
    displayName: `Child ${id}`,
    ageBand: "9-12",
    status: "active",
    childSafeMode: true,
    guardianConsentAt: now,
    guardianNoticeVersion: "guardian-profile-v1",
    createdAt: now,
    updatedAt: now,
  };
}

function queryMatchesProfile(predicate: SQL, row: Profile): boolean {
  const { params, sql } = dialect.sqlToQuery(predicate);
  if (!params.includes(row.guardianUserId)) return false;
  if (sql.includes('"id"')) return params.some(param => Number(param) === row.id);
  return true;
}

beforeEach(() => {
  rows = [profile(1, "guardian-a"), profile(2, "guardian-b")];
  nextId = 3;
  actor = "guardian-a";
  signedIn = true;
  trusted = true;

  mock.method(db, "select", () => ({
    from: (table: unknown) => ({
      where: (predicate: SQL) => {
        if (table === usersTable) {
          const requestedUser = dialect.sqlToQuery(predicate).params[0];
          return { limit: async () => requestedUser === actor ? [{ id: actor }] : [] };
        }
        if (table === studioTrustedDevicesTable) {
          const requestedToken = dialect.sqlToQuery(predicate).params[0];
          return { limit: async () => trusted && requestedToken === deviceTokenHash ? [{ id: 1 }] : [] };
        }
        assert.equal(table, childProfilesTable);
        const matched = rows.filter(row => queryMatchesProfile(predicate, row));
        return { orderBy: async () => matched };
      },
    }),
  }));

  mock.method(db, "insert", (table: unknown) => ({
    values: (values: Partial<Profile>) => ({
      returning: async () => {
        assert.equal(table, childProfilesTable);
        const created = { ...profile(nextId++, String(values.guardianUserId)), ...values } as Profile;
        rows.push(created);
        return [created];
      },
    }),
  }));

  mock.method(db, "update", (table: unknown) => ({
    set: (updates: Partial<Profile>) => ({
      where: (predicate: SQL) => ({
        returning: async () => {
        assert.equal(table, childProfilesTable);
        const row = rows.find(candidate => queryMatchesProfile(predicate, candidate));
        if (!row) return [];
        Object.assign(row, updates);
        return [row];
        },
      }),
    }),
  }));

  mock.method(db, "delete", (table: unknown) => ({
    where: (predicate: SQL) => ({
      returning: async () => {
      assert.equal(table, childProfilesTable);
      const index = rows.findIndex(candidate => queryMatchesProfile(predicate, candidate));
      if (index < 0) return [];
      const [deleted] = rows.splice(index, 1);
      return [{ id: deleted.id }];
      },
    }),
  }));
});

afterEach(() => mock.restoreAll());

async function request(
  path: string,
  options: { method?: string; body?: unknown; guardian?: string; authenticated?: boolean; trustedDevice?: boolean } = {},
) {
  actor = options.guardian ?? "guardian-a";
  signedIn = options.authenticated ?? true;
  trusted = options.trustedDevice ?? true;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, clerkSession(
      signedIn ? { userId: actor, email: "guardian@example.test" } : null,
    ));
    if (trusted) req.headers["x-studio-device"] = deviceToken;
    req.log = { error() {}, warn() {}, info() {} } as typeof req.log;
    next();
  });
  app.use("/api", routes);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  });
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address() as { port: number };
    return await fetch(`http://127.0.0.1:${address.port}/api/studio/child-profiles${path}`, {
      method: options.method ?? "GET",
      headers: options.body === undefined ? {} : { "content-type": "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test("profile list and direct-ID mutations are restricted to the signed-in guardian", async () => {
  const list = await request("");
  assert.equal(list.status, 200);
  const visible = await list.json() as Profile[];
  assert.deepEqual(visible.map(item => item.id), [1]);

  const foreignEdit = await request("/2", {
    method: "PATCH",
    body: { displayName: "Changed by another guardian" },
  });
  assert.equal(foreignEdit.status, 404, await foreignEdit.text());
  assert.equal(rows.find(item => item.id === 2)?.displayName, "Child 2");

  const foreignDelete = await request("/2", { method: "DELETE" });
  assert.equal(foreignDelete.status, 404);
  assert.ok(rows.some(item => item.id === 2));
});

test("creation requires guardian confirmation and derives ownership and safety settings on the server", async () => {
  const unconfirmed = await request("", {
    method: "POST",
    body: { displayName: "River", ageBand: "9-12", guardianConsent: false },
  });
  assert.equal(unconfirmed.status, 400);
  assert.equal(rows.length, 2);

  const created = await request("", {
    method: "POST",
    body: {
      displayName: "River",
      ageBand: "9-12",
      guardianConsent: true,
      guardianUserId: "guardian-b",
      status: "paused",
      childSafeMode: false,
    },
  });
  assert.equal(created.status, 201);
  const data = await created.json() as Profile;
  assert.equal(data.guardianUserId, undefined);
  assert.equal(data.displayName, "River");
  assert.equal(data.childSafeMode, true);
  assert.equal(data.status, "active");
  assert.equal(rows.find(item => item.id === data.id)?.guardianUserId, "guardian-a");
});

test("an untrusted device and an unauthenticated request cannot manage profiles", async () => {
  assert.equal((await request("", { trustedDevice: false })).status, 403);
  assert.equal((await request("", { authenticated: false })).status, 401);
});

test("a guardian can pause, resume, edit, and delete their own profile", async () => {
  const updated = await request("/1", {
    method: "PATCH",
    body: { displayName: "Sparrow", status: "paused" },
  });
  const updatedProfile = await updated.json() as Profile;
  assert.equal(updated.status, 200);
  assert.deepEqual(
    [updatedProfile.displayName, rows[0].status],
    ["Sparrow", "paused"],
  );

  const resumed = await request("/1", { method: "PATCH", body: { status: "active" } });
  assert.equal(resumed.status, 200);
  assert.equal(rows[0].status, "active");

  assert.equal((await request("/1", { method: "DELETE" })).status, 204);
  assert.equal(rows.some(item => item.id === 1), false);
});
