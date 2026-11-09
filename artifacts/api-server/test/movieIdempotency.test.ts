import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, mock, test } from "node:test";
import { randomUUID } from "node:crypto";
import express from "express";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { db, pool, studioExportsTable } from "@workspace/db";
import { movieDb } from "../src/lib/movieRenderer";
import movieRoutes from "../src/routes/movieExports";

// Exercise the real route against PostgreSQL in an isolated schema, including
// the actual unique index and concurrent inserts. Never touch saved movie rows.
const schema = `movie_idempotency_${randomUUID().replaceAll("-", "")}`;
const client = await pool.connect();
const isolatedDb = drizzle(client);
let server: ReturnType<express.Express["listen"]>;
let origin: string;
const input = { episodeId: null, aspectRatio: "16:9", quality: "720p", requestId: "lost-response" };
before(async () => {
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET search_path TO "${schema}"`);
  await client.query(`
    CREATE TABLE studio_exports (
      id serial PRIMARY KEY, request_id text UNIQUE, episode_id integer,
      aspect_ratio text NOT NULL, quality text NOT NULL,
      status text NOT NULL DEFAULT 'queued', progress integer NOT NULL DEFAULT 0,
      object_path text, size_bytes bigint, error text, started_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE studio_episodes (
      id integer PRIMARY KEY, project_id integer, number integer, title text,
      summary text, status text, progress integer, duration text
    );
    INSERT INTO studio_episodes VALUES (1), (2);
  `);
  const app = express();
  app.use(express.json());
  app.use("/api", movieRoutes);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
beforeEach(async () => {
  await client.query("TRUNCATE studio_exports RESTART IDENTITY");
  mock.method(db, "select", isolatedDb.select.bind(isolatedDb));
  mock.method(db, "insert", isolatedDb.insert.bind(isolatedDb));
  // Job admission is tested here, not rendering or access to private storage.
  mock.method(movieDb, "update", () => ({ set: () => ({ where: async () => [] }) }));
  mock.method(movieDb, "select", () => ({ from: () => ({
    where: () => ({ orderBy: () => ({ limit: async () => [] }) }),
  }) }));
});
afterEach(() => mock.restoreAll());
after(async () => {
  try {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await client.query("RESET search_path");
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    client.release();
    await pool.end();
  }
});
const request = (data: unknown = input) => fetch(`${origin}/api/studio/exports`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
});
const count = async () => (await isolatedDb.select().from(studioExportsTable)).length;

for (const status of ["queued", "rendering", "ready", "failed", "cancelled"] as const) {
  test(`a lost response recovers the original ${status} job`, async () => {
    const accepted = await request();
    assert.equal(accepted.status, 202);
    // Simulate a caller that never receives this accepted response.
    const original = await accepted.json();
    await isolatedDb.update(studioExportsTable).set({ status }).where(eq(studioExportsTable.id, original.id));
    const replay = await request({ ...input });
    assert.equal(replay.status, 202);
    const recovered = await replay.json();
    assert.equal(recovered.id, original.id);
    assert.equal(recovered.status, status);
    assert.equal(await count(), 1);
    // The authenticated studio can reconcile a persisted batch by exact intent,
    // rather than mistaking another movie with the same format for this request.
    assert.equal(recovered.requestId, input.requestId);
  });
}

test("concurrent retries insert exactly one job", async () => {
  const responses = await Promise.all(Array.from({ length: 8 }, () => request()));
  assert.ok(responses.every(response => response.status === 202));
  const jobs = await Promise.all(responses.map(response => response.json()));
  assert.equal(new Set(jobs.map(job => job.id)).size, 1);
  assert.equal(await count(), 1);
});

test("saved history includes request keys for reconciliation, and supports older unkeyed exports", async () => {
  const created = await (await request()).json();
  const { requestId: _, ...legacy } = input;
  await request({ ...legacy, quality: "1080p" });
  const response = await fetch(`${origin}/api/studio/exports`);
  assert.equal(response.status, 200);
  const history = await response.json();
  assert.equal(history.find((job: { id: number }) => job.id === created.id).requestId, input.requestId);
  assert.equal(history.find((job: { id: number }) => job.id !== created.id).requestId, null);
});

test("a deliberately new request creates another job even with identical active formats", async () => {
  const first = await (await request()).json();
  const next = await request({ ...input, requestId: "deliberate-new-export" });
  assert.equal(next.status, 202);
  assert.notEqual((await next.json()).id, first.id);
  assert.equal(await count(), 2);
});

test("a reused request ID with different inputs is rejected instead of creating a job", async () => {
  await request();
  for (const change of [{ episodeId: 1 }, { aspectRatio: "9:16" }, { quality: "1080p" }]) {
    assert.equal((await request({ ...input, ...change })).status, 409);
  }
  assert.equal(await count(), 1);
});

test("replays survive a full queue, while new IDs respect the unchanged 16-job limit", async () => {
  const first = await (await request()).json();
  for (let i = 0; i < 15; i++) {
    assert.equal((await request({ ...input, requestId: `other-${i}` })).status, 202);
  }
  const replay = await request();
  assert.equal(replay.status, 202);
  assert.equal((await replay.json()).id, first.id);
  assert.equal((await request({ ...input, requestId: "queue-full" })).status, 429);
  assert.equal(await count(), 16);
});

test("invalid keys fail validation and unkeyed callers retain active-format deduplication", async () => {
  for (const requestId of ["", " ", "x".repeat(129), "invalid/key", null, 1]) {
    assert.equal((await request({ ...input, requestId })).status, 400);
  }
  assert.equal(await count(), 0);
  const { requestId: _, ...legacy } = input;
  const first = await (await request(legacy)).json();
  const replay = await (await request(legacy)).json();
  assert.equal(replay.id, first.id);
  assert.equal(await count(), 1);
  await isolatedDb.update(studioExportsTable).set({ status: "ready" }).where(eq(studioExportsTable.id, first.id));
  assert.notEqual((await (await request(legacy)).json()).id, first.id);
});

test("a replay still works after its original episode is removed", async () => {
  const data = { ...input, episodeId: 1 };
  const original = await (await request(data)).json();
  await client.query("DELETE FROM studio_episodes WHERE id = 1");
  assert.equal((await (await request(data)).json()).id, original.id);
  assert.equal((await request({ ...data, requestId: "new-after-deletion" })).status, 404);
  await client.query("INSERT INTO studio_episodes VALUES (1)");
});
