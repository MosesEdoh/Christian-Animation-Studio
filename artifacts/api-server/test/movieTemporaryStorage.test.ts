import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { MovieTemporaryStorage, MOVIE_RENDER_LEASE_MS } from "../src/lib/movieTemporaryStorage";
import { bundleMovieRecoveryWorker, movieRecoveryProcess } from "./helpers/movieRecoveryProcess";

const exists = async (path: string) => lstat(path).then(() => true, () => false);
const noErrors = (error: unknown) => { throw error; };

test("a killed render owner is reclaimed by API startup/scheduled recovery without harming a live worker", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "movie-process-recovery-test-"));
  const workers: ReturnType<typeof movieRecoveryProcess>[] = [];
  try {
    const source = await bundleMovieRecoveryWorker();
    const start = (mode: "owner" | "recovery") => {
      const worker = movieRecoveryProcess(source, root, mode);
      workers.push(worker);
      return worker;
    };
    const abandonedOwner = start("owner");
    const abandoned = await abandonedOwner.wait("owned");
    const liveOwner = start("owner");
    const live = await liveOwner.wait("owned");
    assert.notEqual(abandoned.pid, live.pid);
    for (const owner of [abandoned, live]) {
      assert.deepEqual(JSON.parse(await readFile(join(owner.directory!, ".render-owner.json"), "utf8")),
        { pid: owner.pid, host: hostname() });
      assert.equal(await readFile(join(owner.directory!, "movie.mp4"), "utf8"), "unfinished render");
    }
    assert.equal(abandonedOwner.child.kill("SIGKILL"), true);
    assert.deepEqual(await abandonedOwner.closed, [null, "SIGKILL"]);
    assert.equal(await exists(join(root, `finally-${abandoned.pid}`)), false, "SIGKILL bypassed finally");
    assert.equal(await exists(abandoned.directory!), true, "The crashed worker left actual render files");

    const recovery = start("recovery");
    await recovery.wait("imported");
    await recovery.wait("listening");
    const startup = await recovery.wait("scan");
    assert.notEqual(startup.pid, abandoned.pid);
    assert.notEqual(startup.pid, live.pid);
    assert.equal(startup.removed, 0, "Startup must preserve a fresh crashed directory");
    recovery.send("state");
    const initialState = await recovery.wait("state");
    assert.deepEqual(initialState.timers, [
      { ms: 5 * 60_000, unrefs: 1 }, { ms: 10_000, unrefs: 1 },
    ], "API startup registered unreferenced recovery and queue timers");
    recovery.send("start-again");
    assert.deepEqual(await recovery.wait("state"), initialState, "Recovery startup is idempotent");

    const info = await lstat(abandoned.directory!);
    const leaseEnd = Math.max(info.mtimeMs, info.ctimeMs, info.birthtimeMs) + MOVIE_RENDER_LEASE_MS;
    recovery.send("tick", leaseEnd);
    assert.equal((await recovery.wait("scan")).removed, 0, "The exact shared lease boundary is protected");
    assert.equal(await exists(abandoned.directory!), true);
    recovery.send("tick", leaseEnd + 1);
    assert.equal((await recovery.wait("scan")).removed, 1, "The next scheduled scan reclaims the dead owner");
    assert.equal(await exists(abandoned.directory!), false);
    recovery.send("tick", leaseEnd + MOVIE_RENDER_LEASE_MS);
    assert.equal((await recovery.wait("scan")).removed, 0, "Repeated recovery is harmless");
    process.kill(live.pid!, 0);
    assert.equal(await readFile(join(live.directory!, "movie.mp4"), "utf8"), "unfinished render",
      "Another process's live render stays protected even well past the lease");

    recovery.send("stop");
    const stopped = await recovery.wait("stopped");
    assert.deepEqual(stopped.timers, [{ ms: 10_000, unrefs: 1 }], "Shutdown clears the recovery timer");
    assert.equal(stopped.created, initialState.created, "A stopped renderer cannot restart recovery");
    assert.equal(recovery.child.kill("SIGTERM"), true);
    assert.deepEqual(await recovery.closed, [0, null], "The API signal handler closes cleanly");

    // A fresh API process must also reclaim already-expired folders at startup,
    // not merely after its first scheduled interval.
    const secondAbandoned = start("owner");
    const second = await secondAbandoned.wait("owned");
    secondAbandoned.child.kill("SIGKILL");
    assert.deepEqual(await secondAbandoned.closed, [null, "SIGKILL"]);
    const expiredInfo = await lstat(second.directory!);
    const expiredNow = Math.max(expiredInfo.mtimeMs, expiredInfo.ctimeMs, expiredInfo.birthtimeMs) +
      MOVIE_RENDER_LEASE_MS + 1;
    const restarted = movieRecoveryProcess(source, root, "recovery", expiredNow);
    workers.push(restarted);
    await restarted.wait("imported");
    await restarted.wait("listening");
    assert.equal((await restarted.wait("scan")).removed, 1, "Startup reclaims an already-expired crashed render");
    assert.equal(await exists(second.directory!), false);
    assert.equal(await exists(join(root, `finally-${second.pid}`)), false);
    assert.equal(await readFile(join(live.directory!, "movie.mp4"), "utf8"), "unfinished render");

    liveOwner.send("release");
    assert.deepEqual(await liveOwner.closed, [0, null]);
    assert.equal(await readFile(join(root, `finally-${live.pid}`), "utf8"), "ran");
    assert.equal(await exists(live.directory!), false, "A healthy owner still performs finally cleanup");
  } finally {
    await Promise.all(workers.map(worker => worker.dispose()));
    await rm(root, { recursive: true, force: true });
  }
});

test("recovery waits beyond the thirty-minute lease, removes legacy leftovers, and is repeatable", async () => {
  const root = await mkdtemp(join(tmpdir(), "movie-recovery-test-"));
  try {
    const storage = new MovieTemporaryStorage(root);
    const legacy = await mkdtemp(join(root, "faith-movie-"));
    await writeFile(join(legacy, "movie.mp4"), "partial");
    const info = await lstat(legacy);
    const created = Math.max(info.mtimeMs, info.ctimeMs, info.birthtimeMs);
    assert.equal(await storage.recover(noErrors, created + MOVIE_RENDER_LEASE_MS), 0);
    assert.equal(await exists(legacy), true);
    assert.equal(await storage.recover(noErrors, created + MOVIE_RENDER_LEASE_MS + 1), 1);
    assert.equal(await exists(legacy), false);
    assert.equal(await storage.recover(noErrors, created + MOVIE_RENDER_LEASE_MS + 2), 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("active directories remain protected locally and across storage instances even beyond the lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "movie-recovery-test-"));
  try {
    const storage = new MovieTemporaryStorage(root);
    const directory = await storage.create();
    const future = Date.now() + MOVIE_RENDER_LEASE_MS * 2;
    assert.equal(await storage.recover(noErrors, future), 0);
    assert.equal(await new MovieTemporaryStorage(root).recover(noErrors, future), 0);
    assert.equal(await exists(directory), true);
    await storage.remove(directory);
    await storage.remove(directory);
    assert.equal(await storage.recover(noErrors, future), 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a terminated owner is recovered only after the lease, including an interrupted marker write", async () => {
  const root = await mkdtemp(join(tmpdir(), "movie-recovery-test-"));
  try {
    const child = spawn(process.execPath, ["-e", ""]);
    const pid = child.pid!;
    await once(child, "exit");
    const directory = await mkdtemp(join(root, "faith-movie-"));
    await writeFile(join(directory, ".render-owner.json"), JSON.stringify({ pid, host: hostname() }));
    const interrupted = await mkdtemp(join(root, "faith-movie-"));
    await writeFile(join(interrupted, ".render-owner.json.pending"), "{");
    const storage = new MovieTemporaryStorage(root);
    assert.equal(await storage.recover(noErrors), 0);
    assert.equal(await storage.recover(noErrors, Date.now() + MOVIE_RENDER_LEASE_MS * 2), 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cleanup is confined to render directories and leaves saved files, symlinks and unknown owners untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "movie-recovery-test-"));
  const outside = await mkdtemp(join(tmpdir(), "movie-persisted-test-"));
  try {
    await writeFile(join(outside, "saved.mp4"), "completed movie");
    await symlink(outside, join(root, "faith-movie-LINKED"));
    await writeFile(join(root, "faith-movie-FILE01"), "not a directory");
    await mkdir(join(root, "faith-movie-not-a-render"));
    await mkdir(join(root, "other-store"));
    for (const owner of ["{", JSON.stringify({ pid: process.pid, host: "unknown-host" }), JSON.stringify({ pid: -1, host: hostname() })]) {
      const directory = await mkdtemp(join(root, "faith-movie-"));
      await writeFile(join(directory, ".render-owner.json"), owner);
    }
    const errors: unknown[] = [];
    const storage = new MovieTemporaryStorage(root);
    const recover = () => storage.recover(error => { errors.push(error); }, Date.now() + MOVIE_RENDER_LEASE_MS * 2);
    const first = recover();
    assert.equal(recover(), first, "overlapping scans share one pass");
    assert.equal(await first, 0);
    assert.equal(errors.length, 1, "malformed marker is reported without stopping the scan");
    assert.equal(await readFile(join(outside, "saved.mp4"), "utf8"), "completed movie");
    assert.equal(await exists(join(root, "faith-movie-LINKED")), true);
    assert.equal(await exists(join(root, "faith-movie-FILE01")), true);
    assert.equal(await exists(join(root, "faith-movie-not-a-render")), true);
    assert.equal(await exists(join(root, "other-store")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
