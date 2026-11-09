import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { MovieTemporaryStorage, MOVIE_RENDER_LEASE_MS } from "../src/lib/movieTemporaryStorage";

const exists = async (path: string) => lstat(path).then(() => true, () => false);
const noErrors = (error: unknown) => { throw error; };

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
