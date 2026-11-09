import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  acquireEpisodeExportLease, PostgresEpisodeAdmissionStore, EpisodeVideoBusyError,
  type EpisodeAdmissionStore,
} from "../src/lib/episodeExportAdmission";

const timing = { leaseMs: 250, renewMs: 30, safetyMs: 80 };
function fakeStore(): EpisodeAdmissionStore & { owners: Set<string> } {
  const owners = new Set<string>();
  return {
    owners,
    async acquire(owner) { owners.add(owner); return true; },
    async renew(owner) { return owners.has(owner); },
    async release(owner) { owners.delete(owner); },
  };
}

test("admission fails closed on saturation or database failure", async () => {
  const store = fakeStore();
  store.acquire = async () => false;
  await assert.rejects(acquireEpisodeExportLease(store, timing), EpisodeVideoBusyError);
  store.acquire = async () => { throw new Error("Database unavailable"); };
  await assert.rejects(acquireEpisodeExportLease(store, timing), /Database unavailable/);
});

test("heartbeat loss aborts work, and release is idempotent", async () => {
  for (const failure of ["expired", "database"]) {
    const store = fakeStore();
    let releases = 0;
    store.release = async owner => { releases++; store.owners.delete(owner); };
    store.renew = async () => {
      if (failure === "database") throw new Error("offline");
      return false;
    };
    const lease = await acquireEpisodeExportLease(store, timing);
    await delay(60);
    assert.equal(lease.signal.aborted, true);
    assert.throws(lease.assertOwned, /ownership was lost/);
    await Promise.all([lease.release(), lease.release()]);
    assert.equal(releases, 1);
  }
});

test("a stalled heartbeat expires locally and cannot resurrect ownership with a late response", async () => {
  const store = fakeStore();
  let finish!: (value: boolean) => void;
  store.renew = () => new Promise(resolve => { finish = resolve; });
  const lease = await acquireEpisodeExportLease(store, timing);
  await delay(220);
  assert.equal(lease.signal.aborted, true);
  finish(true);
  await delay(5);
  assert.equal(lease.signal.aborted, true);
  await lease.release();
});

test("release waits for an in-flight heartbeat before deleting its owner", async () => {
  const store = fakeStore();
  let finish!: (value: boolean) => void;
  store.renew = () => new Promise(resolve => { finish = resolve; });
  const lease = await acquireEpisodeExportLease(store, timing);
  await delay(60);
  const release = lease.release();
  assert.equal(store.owners.size, 1);
  finish(true);
  await release;
  assert.equal(store.owners.size, 0);
  await delay(40);
  assert.equal(store.owners.size, 0);
});

// This is intentionally a real database integration test, never a silently
// skipped/mocked substitute. Each run owns unique pool names and deletes only them.
test("independent processes enforce a global capacity of two and recover from SIGKILL", { timeout: 40_000 }, async t => {
  const { db } = await import("@workspace/db");
  const { sql } = await import("drizzle-orm");
  const poolName = `episode-admission-test-${randomUUID()}`;
  const workerTemp = await mkdtemp(join(tmpdir(), "episode-admission-workers-"));
  const workers: ChildProcess[] = [];
  const messages: Array<{ worker: ChildProcess; id: number; kind: string }> = [];
  const waitFor = async (predicate: (message: typeof messages[number]) => boolean) => {
    for (let attempt = 0; attempt < 1500; attempt++) {
      const found = messages.find(predicate);
      if (found) return found;
      await delay(10);
    }
    assert.fail("Timed out waiting for export worker");
  };
  t.after(async () => {
    await Promise.all(workers.map(async worker => {
      if (worker.exitCode === null && worker.signalCode === null) {
        const exited = once(worker, "exit");
        worker.kill("SIGKILL");
        await exited;
      }
    }));
    await db.execute(sql`DELETE FROM episode_export_leases WHERE pool = ${poolName}`);
    await db.execute(sql`DELETE FROM episode_export_pools WHERE name = ${poolName}`);
    await rm(workerTemp, { recursive: true, force: true });
  });
  for (let index = 0; index < 3; index++) {
    const worker = fork(new URL("./fixtures/episodeAdmissionWorker.ts", import.meta.url), [poolName], {
      execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "inherit", "ipc"],
      env: { ...process.env, TMPDIR: workerTemp },
    });
    workers.push(worker);
    worker.on("message", message => messages.push({ worker, ...message as { id: number; kind: string } }));
  }
  await Promise.all(workers.map(worker => waitFor(message => message.worker === worker && message.kind === "ready")));
  // Competing requests span three API processes, not three promises in one process.
  for (let id = 1; id <= 12; id++) workers[(id - 1) % 3].send({ command: "start", id });
  await Promise.all(Array.from({ length: 12 }, (_, index) => waitFor(message => message.id === index + 1)));
  const admitted = messages.filter(message => message.kind === "admitted");
  assert.equal(admitted.length, 2);
  assert.equal(messages.filter(message => message.kind === "busy").length, 10);
  // Living owners renew across the original expiry.
  await delay(3400);
  workers[2].send({ command: "start", id: 20 });
  assert.equal((await waitFor(message => message.id === 20)).kind, "busy");
  const victim = admitted[0].worker;
  const exited = once(victim, "exit");
  victim.kill("SIGKILL");
  await exited;
  await delay(3400);
  const survivor = workers.find(worker => worker !== victim)!;
  survivor.send({ command: "start", id: 21 });
  assert.equal((await waitFor(message => message.id === 21)).kind, "admitted");
  // A crash may have killed both original owners if they shared a worker.
  const livingOriginals = admitted.filter(message => message.worker !== victim);
  const expectedFree = 2 - livingOriginals.length - 1;
  if (expectedFree) {
    survivor.send({ command: "start", id: 22 });
    assert.equal((await waitFor(message => message.id === 22)).kind, "admitted");
  }
  survivor.send({ command: "start", id: 23 });
  assert.equal((await waitFor(message => message.id === 23)).kind, "busy");
  survivor.send({ command: "cancel", id: 21 });
  assert.equal((await waitFor(message => message.id === 21 && message.kind === "cancelled")).kind, "cancelled");
  survivor.send({ command: "start", id: 24 });
  assert.equal((await waitFor(message => message.id === 24)).kind, "admitted");
});

test("expired owners cannot renew or release a replacement, and capacity mismatches fail closed", async t => {
  const { db } = await import("@workspace/db");
  const { sql } = await import("drizzle-orm");
  const poolName = `episode-owner-test-${randomUUID()}`;
  t.after(async () => {
    await db.execute(sql`DELETE FROM episode_export_leases WHERE pool = ${poolName}`);
    await db.execute(sql`DELETE FROM episode_export_pools WHERE name = ${poolName}`);
  });
  const store = new PostgresEpisodeAdmissionStore(poolName, 1, 200);
  const oldOwner = randomUUID();
  const newOwner = randomUUID();
  assert.equal(await store.acquire(oldOwner), true);
  await delay(250);
  assert.equal(await store.renew(oldOwner), false);
  assert.equal(await store.acquire(newOwner), true);
  await Promise.all([store.release(oldOwner), store.release(oldOwner)]);
  assert.equal(await store.acquire(randomUUID()), false);
  const wrongCapacity = new PostgresEpisodeAdmissionStore(poolName, 2);
  await assert.rejects(wrongCapacity.acquire(randomUUID()), /differs from the shared pool/);
  await store.release(newOwner);
  assert.equal(await store.acquire(randomUUID()), true);
});
