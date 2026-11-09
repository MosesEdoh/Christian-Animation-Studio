import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EpisodeTemporaryStorage, EPISODE_TEMPORARY_RETENTION_MS } from "../src/lib/episodeTemporaryStorage";
import { EPISODE_EXPORT_LEASE_MS, EPISODE_EXPORT_LIFETIME_MS } from "../src/lib/episodeExportTiming";

const markerName = ".episode-owner.json";
const noErrors = (error: unknown) => { throw error; };
const exists = (path: string) => lstat(path).then(() => true, () => false);
const future = () => Date.now() + EPISODE_TEMPORARY_RETENTION_MS * 3;

async function deadPid() {
  const child = spawn(process.execPath, ["-e", ""]);
  const pid = child.pid!;
  await once(child, "exit");
  return pid;
}

async function abandoned(root: string, overrides: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(root, "frame-faith-episode-"));
  await writeFile(join(directory, markerName), JSON.stringify({
    version: 1, owner: randomUUID(), pid: await deadPid(), host: hostname(),
    deadline: Date.now() + EPISODE_EXPORT_LIFETIME_MS, mediaPid: null, ...overrides,
  }));
  await writeFile(join(directory, "episode.mp4"), "unfinished");
  return directory;
}

test("legacy and interrupted-creation folders wait for the total deadline plus lease grace; cleanup repeats safely", async t => {
  const root = await mkdtemp(join(tmpdir(), "episode-recovery-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = new EpisodeTemporaryStorage(async () => { assert.fail("Legacy folders have no lease owner"); }, root);
  const legacy = await mkdtemp(join(root, "frame-faith-episode-"));
  const interrupted = await mkdtemp(join(root, "frame-faith-episode-"));
  await writeFile(join(interrupted, `${markerName}.pending`), "{");
  const info = await lstat(interrupted);
  const created = Math.max(info.mtimeMs, info.ctimeMs, info.birthtimeMs);
  assert.equal(await storage.recover(noErrors, created + EPISODE_TEMPORARY_RETENTION_MS - 1000), 0);
  assert.equal(await exists(legacy), true);
  assert.equal(await exists(interrupted), true);
  assert.equal(await storage.recover(noErrors, future()), 2);
  assert.equal(await storage.recover(noErrors, future()), 0);
});

test("a crashed owner's folder requires both the deadline grace and an expired admission lease", async t => {
  const root = await mkdtemp(join(tmpdir(), "episode-recovery-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const deadline = future();
  const owner = randomUUID();
  const directory = await abandoned(root, { deadline, owner });
  let active = true;
  let probes = 0;
  const storage = new EpisodeTemporaryStorage(async value => {
    assert.equal(value, owner);
    probes++;
    return active;
  }, root);
  assert.equal(await storage.recover(noErrors, deadline + EPISODE_EXPORT_LEASE_MS), 0);
  assert.equal(probes, 0);
  assert.equal(await storage.recover(noErrors, deadline + EPISODE_EXPORT_LEASE_MS + 1), 0);
  assert.equal(probes, 1);
  assert.equal(await exists(directory), true);
  active = false;
  assert.equal(await storage.recover(noErrors, deadline + EPISODE_EXPORT_LEASE_MS + 2), 1);
  assert.equal(await storage.recover(noErrors, deadline + EPISODE_EXPORT_LEASE_MS + 3), 0);
});

test("local encoding and retained delivery folders, and live owners in another instance, stay protected", async t => {
  const root = await mkdtemp(join(tmpdir(), "episode-recovery-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = new EpisodeTemporaryStorage(async () => { assert.fail("Local owners need no database probe"); }, root);
  const encoding = await storage.create(randomUUID(), Date.now() + EPISODE_EXPORT_LIFETIME_MS);
  await storage.setMediaProcess(encoding, process.pid);
  const delivery = await storage.create(randomUUID(), Date.now() + EPISODE_EXPORT_LIFETIME_MS);
  await writeFile(join(delivery, "episode.mp4"), "retained for HTTP download");
  assert.equal(await storage.recover(noErrors, future()), 0);
  assert.equal(await new EpisodeTemporaryStorage(async () => false, root).recover(noErrors, future()), 0);
  assert.equal(await exists(encoding), true);
  assert.equal(await readFile(join(delivery, "episode.mp4"), "utf8"), "retained for HTTP download");
  await Promise.all([storage.remove(encoding), storage.remove(delivery)]);
  await storage.remove(delivery);
  assert.equal(await storage.recover(noErrors, future()), 0);
});

test("a surviving media process and the spawn-publication crash window remain protected", async t => {
  const root = await mkdtemp(join(tmpdir(), "episode-recovery-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  t.after(() => { child.kill("SIGKILL"); });
  const directory = await abandoned(root, { mediaPid: child.pid });
  const starting = await abandoned(root, { mediaPid: "starting" });
  const storage = new EpisodeTemporaryStorage(async () => false, root);
  assert.equal(await storage.recover(noErrors, future()), 0);
  assert.equal(await exists(starting), true);
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  assert.equal(await storage.recover(noErrors, future()), 1);
  assert.equal(await exists(directory), false);
  assert.equal(await exists(starting), true);
});

test("database probe failures retain files and a later successful pass recovers them", async t => {
  const root = await mkdtemp(join(tmpdir(), "episode-recovery-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = await abandoned(root);
  let offline = true;
  const storage = new EpisodeTemporaryStorage(async () => {
    if (offline) throw new Error("Database unavailable");
    return false;
  }, root);
  const errors: unknown[] = [];
  assert.equal(await storage.recover(error => { errors.push(error); }, future()), 0);
  assert.equal(errors.length, 1);
  assert.equal(await exists(directory), true);
  offline = false;
  assert.equal(await storage.recover(noErrors, future()), 1);
});

test("permission-denied process probes do not count as proof of abandonment", async t => {
  const root = await mkdtemp(join(tmpdir(), "episode-recovery-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = await abandoned(root);
  t.mock.method(process, "kill", () => { throw Object.assign(new Error("Not permitted"), { code: "EPERM" }); });
  const storage = new EpisodeTemporaryStorage(async () => { assert.fail("Uncertain process must be retained"); }, root);
  assert.equal(await storage.recover(noErrors, future()), 0);
  assert.equal(await exists(directory), true);
});

test("recovery ignores saved files, storyboard renders, symlinks, malformed markers, and unknown owners", async t => {
  const root = await mkdtemp(join(tmpdir(), "episode-recovery-test-"));
  const outside = await mkdtemp(join(tmpdir(), "episode-saved-test-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  await writeFile(join(outside, "saved.mp4"), "saved movie");
  await symlink(outside, join(root, "frame-faith-episode-LINKED"));
  await writeFile(join(root, "frame-faith-episode-FILE01"), "file not folder");
  await mkdir(join(root, "frame-faith-episode-not-a-temp"));
  const storyboard = await mkdtemp(join(root, "faith-movie-"));
  const unknown = await abandoned(root, { host: "other-host" });
  const invalid = await abandoned(root, { owner: "not-a-uuid" });
  const malformed = await abandoned(root);
  await writeFile(join(malformed, markerName), "{");
  const linked = await mkdtemp(join(root, "frame-faith-episode-"));
  await symlink(join(outside, "saved.mp4"), join(linked, markerName));
  const large = await abandoned(root);
  await writeFile(join(large, markerName), "x".repeat(2049));
  const storage = new EpisodeTemporaryStorage(async () => { assert.fail("Unknown ownership must not be queried"); }, root);
  const errors: unknown[] = [];
  assert.equal(await storage.recover(error => { errors.push(error); }, future()), 0);
  assert.equal(errors.length, 1);
  for (const path of [storyboard, unknown, invalid, malformed, linked, large]) assert.equal(await exists(path), true);
  assert.equal(await readFile(join(outside, "saved.mp4"), "utf8"), "saved movie");
});

test("overlapping scans share a pass and recheck folder/marker identity after a pending lease probe", async t => {
  const root = await mkdtemp(join(tmpdir(), "episode-recovery-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const replacement of ["folder", "marker"]) {
    const directory = await abandoned(root);
    let finish!: (active: boolean) => void;
    let probing!: () => void;
    const probed = new Promise<void>(resolve => { probing = resolve; });
    const storage = new EpisodeTemporaryStorage(() => new Promise(resolve => {
      finish = resolve;
      probing();
    }), root);
    const recovery = storage.recover(noErrors, future());
    assert.equal(storage.recover(noErrors, future()), recovery);
    await probed;
    if (replacement === "folder") {
      await rm(directory, { recursive: true });
      await mkdir(directory);
    } else {
      const pending = join(directory, `${markerName}.pending`);
      await writeFile(pending, await readFile(join(directory, markerName)));
      await rename(pending, join(directory, markerName));
    }
    finish(false);
    assert.equal(await recovery, 0);
    assert.equal(await exists(directory), true);
    await rm(directory, { recursive: true });
  }
});
