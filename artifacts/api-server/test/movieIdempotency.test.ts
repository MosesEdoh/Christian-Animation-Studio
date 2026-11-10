import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, mock, test } from "node:test";
import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
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

type WorkerMessage = {
  kind: string;
  origin?: string;
  pid?: number;
  backendPid?: number;
  headersSent?: boolean;
  job?: { id: number; requestId: string; status: string };
};
function startApiProcess(gated = false) {
  const child = fork(new URL("./fixtures/movieIdempotencyServer.ts", import.meta.url), [
    schema, gated ? "gated" : "ungated",
  ], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const messages: WorkerMessage[] = [];
  child.on("message", message => messages.push(message as WorkerMessage));
  const waitFor = async (kind: string) => {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const message = messages.find(message => message.kind === kind);
      if (message) return message;
      assert.equal(child.exitCode, null, `API process exited waiting for ${kind}`);
      assert.equal(child.signalCode, null, `API process was killed waiting for ${kind}`);
      await delay(10);
    }
    assert.fail(`Timed out waiting for API process message: ${kind}`);
  };
  return { child, waitFor };
}
async function stopApiProcess(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  assert.ok(child.kill("SIGKILL"));
  await exited;
}
const processRequest = (origin: string, data: unknown = input, withholdResponse = false) =>
  fetch(`${origin}/api/studio/exports`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-test-withhold-response": String(withholdResponse) },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(15_000),
  });

test("independent API processes arbitrate simultaneous request IDs in PostgreSQL", { timeout: 30_000 }, async t => {
  const workers = [startApiProcess(true), startApiProcess(true)];
  t.after(() => Promise.all(workers.map(worker => stopApiProcess(worker.child))));
  const ready = await Promise.all(workers.map(worker => worker.waitFor("ready")));
  assert.notEqual(ready[0].pid, ready[1].pid);
  assert.notEqual(ready[0].backendPid, ready[1].backendPid);
  const origins = ready.map(message => message.origin!);
  // Attach rejection handlers immediately, including if setup fails.
  const pending = origins.map(origin => processRequest(origin).then(
    response => ({ response }), error => ({ error }),
  ));
  await Promise.all(workers.map(worker => worker.waitFor("insert-ready")));
  workers.forEach(worker => worker.child.send({ command: "release-inserts" }));
  const jobs = await Promise.all(pending.map(async request => {
    const result = await request;
    if ("error" in result) throw result.error;
    assert.equal(result.response.status, 202);
    return result.response.json();
  }));
  assert.equal(jobs[0].id, jobs[1].id);
  assert.equal(jobs[0].requestId, input.requestId);
  assert.equal(jobs[1].requestId, input.requestId);
  assert.equal(await count(), 1);

  // Both instances enforce input identity, even when the loser replays.
  for (const origin of origins) {
    for (const change of [{ episodeId: 1 }, { aspectRatio: "9:16" }, { quality: "1080p" }]) {
      assert.equal((await processRequest(origin, { ...input, ...change })).status, 409);
    }
  }
  assert.equal(await count(), 1);
  const deliberate = await processRequest(origins[1], { ...input, requestId: "cross-process-new" });
  assert.equal(deliberate.status, 202);
  assert.notEqual((await deliberate.json()).id, jobs[0].id);
  assert.equal(await count(), 2);
});

test("a fresh API process recovers a committed movie after its predecessor dies before delivery", { timeout: 30_000 }, async t => {
  const first = startApiProcess();
  t.after(() => stopApiProcess(first.child));
  const originalReady = await first.waitFor("ready");
  const lostResponse = processRequest(originalReady.origin!, input, true).then(
    () => { throw new Error("The interrupted request must not receive a response"); },
    error => error,
  );
  const accepted = await first.waitFor("accepted-without-delivery");
  assert.equal(accepted.headersSent, false);
  assert.ok(accepted.job);
  const [persisted] = await isolatedDb.select().from(studioExportsTable);
  assert.equal(persisted.id, accepted.job.id);
  assert.equal(persisted.requestId, input.requestId);
  assert.equal(persisted.status, "queued");
  await stopApiProcess(first.child);
  assert.equal(first.child.signalCode, "SIGKILL");
  const deliveryError = await lostResponse;
  assert.equal(deliveryError.name, "TypeError", "socket loss, not the request timeout, must interrupt delivery");

  // Start only after the original process exits: no shared module state,
  // connection, worker flag, or cached response can satisfy this replay.
  const replacement = startApiProcess();
  t.after(() => stopApiProcess(replacement.child));
  const restarted = await replacement.waitFor("ready");
  assert.notEqual(restarted.pid, originalReady.pid);
  assert.notEqual(restarted.backendPid, originalReady.backendPid);
  const recovered = await processRequest(restarted.origin!);
  assert.equal(recovered.status, 202);
  const job = await recovered.json();
  assert.equal(job.id, persisted.id);
  assert.equal(job.requestId, input.requestId);
  assert.equal(job.status, persisted.status);
  assert.equal(await count(), 1);
  for (const change of [{ episodeId: 1 }, { aspectRatio: "9:16" }, { quality: "1080p" }]) {
    assert.equal((await processRequest(restarted.origin!, { ...input, ...change })).status, 409);
  }
  assert.equal(await count(), 1);
  const deliberate = await processRequest(restarted.origin!, { ...input, requestId: "after-restart-new" });
  assert.equal(deliberate.status, 202);
  assert.notEqual((await deliberate.json()).id, persisted.id);
  assert.equal(await count(), 2);
});

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
