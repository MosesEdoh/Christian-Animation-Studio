import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import express from "express";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { hashTrustedDeviceToken } from "../src/lib/trustedDevice";
import { clerkSession } from "./helpers/clerkSession";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost/unused";
const { db, studioTrustedDevicesTable, usersTable } = await import("@workspace/db");
const { requireStudioAccess } = await import("../src/middlewares/studioAccess");
const { default: studioRouter } = await import("../src/routes/studio");
const dialect = new PgDialect();
let rows: Array<{ id: string; email?: string; firstName?: string }>;
let devices: Array<{ id: number; tokenHash: string; label: string; createdByUserId?: string }>;
let lookups: string[];
let inserts: unknown[];
let race: boolean;
const trustedToken = "a".repeat(43);
const trustedHash = hashTrustedDeviceToken(trustedToken);
beforeEach(() => {
  rows = [];
  devices = [{ id: 1, tokenHash: trustedHash, label: "Test browser" }];
  lookups = []; inserts = []; race = false;
  mock.method(db, "select", () => ({
    from: (table: unknown) => ({ where: (predicate: SQL) => {
      const value = dialect.sqlToQuery(predicate).params[0] as string;
      if (table === studioTrustedDevicesTable) {
        return { limit: async () => devices.filter(device => device.tokenHash === value) };
      }
      assert.equal(table, usersTable);
      lookups.push(value);
      return { limit: async () => rows.filter(row => row.id === value) };
    } }),
  }));
  mock.method(db, "insert", () => ({
    values: (value: { id?: string; tokenHash?: string; label?: string; createdByUserId?: string }) => {
      inserts.push(value);
      if (value.tokenHash) {
        devices.push({
          id: devices.length + 1,
          tokenHash: value.tokenHash,
          label: value.label ?? "Test device",
          createdByUserId: value.createdByUserId,
        });
        return {};
      }
      rows.push({ id: value.id ?? "" });
      return { onConflictDoNothing: () => ({ returning: async () => race ? [] : [value] }) };
    },
  }));
  mock.method(db, "delete", () => ({
    where: (predicate: SQL) => {
      const hash = dialect.sqlToQuery(predicate).params[0] as string;
      const removed = devices.filter(device => device.tokenHash === hash);
      devices = devices.filter(device => device.tokenHash !== hash);
      return { returning: async () => removed.map(device => ({ id: device.id })) };
    },
  }));
});
afterEach(() => {
  mock.restoreAll();
});
async function request(
  claims: Record<string, unknown> | null,
  options: { nativeId?: string; path?: string; deviceToken?: string | null } = {},
) {
  const app = express();
  app.use((req, _res, next) => {
    Object.assign(req, clerkSession(claims, options.nativeId));
    next();
  });
  app.use("/studio", requireStudioAccess);
  app.get("/studio", (req, res) => res.json({ id: req.dbUser?.id }));
  app.get("/studio/trusted-device/status", (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  try {
    const headers = options.deviceToken === null ? undefined : { "x-studio-device": options.deviceToken ?? trustedToken };
    return await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}${options.path ?? "/studio"}`, { headers });
  }
  finally { await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())); }
}
test("migrated users resolve their legacy local row, never the Clerk native ID", async () => {
  rows = [{ id: "legacy-subject", email: "old@example.test", firstName: "Original" }];
  const response = await request({ userId: "legacy-subject", email: "any@example.test" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: "legacy-subject" });
  assert.deepEqual(lookups, ["legacy-subject"]);
  assert.deepEqual(inserts, []);
  assert.equal(rows[0].firstName, "Original");
});
test("new accounts provision only the ID and reuse their local row on subsequent requests", async () => {
  const claims = { userId: "user_new", email: "any@example.test", firstName: "New" };
  assert.equal((await request(claims, { nativeId: "user_new" })).status, 200);
  assert.equal((await request(claims, { nativeId: "user_new" })).status, 200);
  assert.deepEqual(inserts, [{ id: "user_new" }]);
});
test("concurrent first-request inserts reload the winning row", async () => {
  race = true;
  const response = await request({ userId: "new-subject", email: "any@example.test" });
  assert.equal(response.status, 200);
  assert.deepEqual(lookups, ["new-subject", "new-subject"]);
});
test("signed-out, untrusted, unverified and missing-bridge sessions fail closed without provisioning", async () => {
  assert.equal((await request(null)).status, 401);
  assert.equal((await request({ userId: "untrusted", email: "another@example.test" }, { deviceToken: null })).status, 403);
  assert.equal((await request({ userId: "unknown-device", email: "any@example.test" }, { deviceToken: "b".repeat(43) })).status, 403);
  assert.equal((await request({ userId: "unverified", email: "any@example.test", email_verified: false })).status, 403);
  assert.equal((await request({ email: "any@example.test" })).status, 401);
  assert.deepEqual(inserts, []);
  assert.deepEqual(lookups, []);
});

test("verified users can enroll from an untrusted device but still need device trust for studio data", async () => {
  rows = [{ id: "verified-device-user" }];
  devices = [];
  const mobileEnrollment = await requestDeviceApi("/studio/trusted-device/enroll", {
    method: "POST",
    body: { platform: "mobile", label: "My phone" },
  });
  assert.equal(mobileEnrollment.status, 201);
  const mobilePayload = await mobileEnrollment.json() as { trusted: boolean; deviceToken: string; deviceLabel: string };
  assert.equal(mobilePayload.trusted, true);
  assert.equal(mobilePayload.deviceLabel, "My phone");
  assert.match(mobilePayload.deviceToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(devices.length, 1);
  assert.equal(devices[0]?.tokenHash, hashTrustedDeviceToken(mobilePayload.deviceToken));
  assert.ok(!Object.values(devices[0] ?? {}).includes(mobilePayload.deviceToken));

  const mobileStatus = await requestDeviceApi("/studio/trusted-device/status", {
    headers: { "x-studio-device": mobilePayload.deviceToken },
  });
  assert.deepEqual(await mobileStatus.json(), { trusted: true, deviceLabel: "My phone" });
  const mobileRevoke = await requestDeviceApi("/studio/trusted-device/revoke", {
    method: "POST",
    headers: { "x-studio-device": mobilePayload.deviceToken },
  });
  assert.deepEqual(await mobileRevoke.json(), { revoked: true });

  const webEnrollment = await requestDeviceApi("/studio/trusted-device/enroll", {
    method: "POST",
    body: { platform: "web", label: "My browser" },
  });
  assert.equal(webEnrollment.status, 201);
  const webPayload = await webEnrollment.json() as { deviceToken: string | null };
  assert.equal(webPayload.deviceToken, null);
  const cookie = webEnrollment.headers.get("set-cookie");
  assert.match(cookie ?? "", /HttpOnly/i);
  assert.match(cookie ?? "", /SameSite=Lax/i);
  const cookieHeader = cookie?.split(";", 1)[0];
  const webStatus = await requestDeviceApi("/studio/trusted-device/status", {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  });
  assert.deepEqual(await webStatus.json(), { trusted: true, deviceLabel: "My browser" });
});

async function requestDeviceApi(
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, clerkSession({ userId: "verified-device-user", email: "verified@example.test" }));
    next();
  });
  app.use("/api/studio", requireStudioAccess);
  app.use("/api", studioRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  try {
    return await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
