import assert from "node:assert/strict";
import { beforeEach, afterEach, mock, test } from "node:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { runMovieEncoder } from "../src/lib/movieWork";
import { MovieBudget, movieLimits } from "../src/lib/movieBudget";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost/unused";
const { db, studioExportsTable, studioProjectsTable, studioEpisodesTable, studioScenesTable, studioShotsTable } = await import("@workspace/db");
const { cancelMovieExport, wakeMovieWorker, exportView, movieDb } = await import("../src/lib/movieRenderer");
const { default: movieRoutes } = await import("../src/routes/movieExports");
const { storePrivateMedia } = await import("../src/lib/privateMedia");
const { objectStorageClient, ObjectStorageService } = await import("../src/lib/objectStorage");
type Row = typeof studioExportsTable.$inferSelect;
let rows: Row[];
let framesStarted: boolean;
let largeSeries: boolean;
let reference: boolean;
let stallWrite: ((patch: Partial<Row>, condition: SQL, apply: () => Row[]) => Promise<Row[]> | undefined) | undefined;
const dialect = new PgDialect();
const makeJob = (id: number, status: Row["status"] = "queued"): Row => ({
  id, requestId: null, episodeId: 1, status, aspectRatio: "16:9", quality: "720p",
  progress: 0, objectPath: null, sizeBytes: null, error: null, startedAt: null, createdAt: new Date(),
});
// Evaluate the worker's real Drizzle predicates, not hand-written cancellation logic.
function matches(row: Row, condition: SQL) {
  const { sql, params } = dialect.sqlToQuery(condition);
  let matches = true;
  for (const match of sql.matchAll(/"studio_exports"\."(id|status|started_at)"\s*(=|<|in)\s*(\$\d+|\([^)]*\))/g)) {
    const rawValue = row[match[1] === "started_at" ? "startedAt" : match[1] as "id" | "status"];
    const value = rawValue instanceof Date ? rawValue.getTime() : rawValue;
    const values = [...match[3].matchAll(/\$(\d+)/g)].map(param => {
      const parameter = params[Number(param[1]) - 1];
      return match[1] === "started_at" ? new Date(parameter as string).getTime() : parameter;
    });
    matches &&= match[2] === "in" ? values.includes(value) : match[2] === "=" ? value === values[0] :
      typeof value === "number" && value < (values[0] as number);
  }
  return matches;
}

beforeEach(() => {
  rows = [];
  framesStarted = false;
  largeSeries = false;
  reference = false;
  stallWrite = undefined;
  mock.method(db, "select", () => ({
    from(table: unknown) {
      if (table === studioExportsTable) {
        let condition: SQL;
        const query = {
          where(value: SQL) { condition = value; return query; },
          orderBy() { return query; },
          limit() { return Promise.resolve(rows.filter(row => matches(row, condition)).map(row => ({ ...row })).slice(0, 1)); },
          then(resolve: (value: Row[]) => unknown) { return Promise.resolve(rows.filter(row => matches(row, condition)).map(row => ({ ...row }))).then(resolve); },
        };
        return query;
      }
      let episodeId: number | undefined;
      const result = () => table === studioProjectsTable ? [{ title: "Cancellation test" }] :
        table === studioEpisodesTable ? Array.from({ length: largeSeries && !episodeId ? 2001 : 1 }, (_, i) =>
          ({ id: i + 1, number: i + 1, title: "Test", summary: "Test" })) :
        table === studioScenesTable ? Array.from({ length: largeSeries || reference ? 1 : 150 }, (_, i) => ({
          id: i + 1, episodeId: 1, number: i + 1, content: "Test card", heading: "Test scene", synopsis: "", duration: "0:05",
        })) : table === studioShotsTable && reference ? [{
          id: 1, sceneId: 1, referenceImageUrl: "/objects/large.png", shotType: "", movement: "", beat: "",
        }] : [];
      const query = {
        where(condition?: SQL) {
          if (table === studioEpisodesTable && condition) episodeId = dialect.sqlToQuery(condition).params[0] as number;
          return query;
        },
        limit: async (limit: number) => { framesStarted = true; return result().slice(0, limit); },
        orderBy: () => query,
      };
      return query;
    },
  }));
  mock.method(db, "update", () => ({
    set(patch: Partial<Row>) {
      return {
        where(condition: SQL) {
          const apply = () => {
            const changed = rows.filter(row => matches(row, condition));
            changed.forEach(row => Object.assign(row, patch));
            return changed.map(row => ({ ...row }));
          };
          const promise = stallWrite?.(patch, condition, apply) ?? Promise.resolve(apply());
          return Object.assign(promise, { returning: () => promise });
        },
      };
    },
  }));
  mock.method(movieDb, "select", db.select);
  mock.method(movieDb, "update", db.update);
});
afterEach(() => mock.restoreAll());

test("movie database work has server, client, and connection timeouts independent of interactive requests", () => {
  assert.notEqual(movieDb.$client, db.$client);
  assert.equal(movieDb.$client.options.connectionTimeoutMillis, 5000);
  assert.equal(movieDb.$client.options.statement_timeout, 5000);
  assert.equal(movieDb.$client.options.query_timeout, 6000);
  assert.equal(movieDb.$client.options.max, 2);
});

test("completed movies persist the exact uploaded MP4 byte size", async () => {
  largeSeries = true;
  let uploadedBytes = 0;
  mock.method(ObjectStorageService.prototype, "getPrivateObjectDir", () => "/test/private");
  mock.method(objectStorageClient, "bucket", () => ({
    file: () => ({ createWriteStream: () => new Writable({
      write(chunk, _encoding, callback) { uploadedBytes += chunk.length; callback(); },
    }) }),
  }));
  rows.push(makeJob(1));
  await wakeMovieWorker();
  assert.equal(rows[0].status, "ready");
  assert.ok(uploadedBytes > 0);
  assert.equal(rows[0].sizeBytes, uploadedBytes);
  assert.equal(exportView(rows[0]).sizeBytes, uploadedBytes);
});

test("queued cancellation is idempotent, hidden from downloads, and excluded from worker recovery", async () => {
  rows.push(makeJob(1));
  assert.equal((await cancelMovieExport(1))?.status, "cancelled");
  assert.equal((await cancelMovieExport(1))?.status, "cancelled");
  await wakeMovieWorker();
  assert.equal(rows[0].status, "cancelled");
  assert.equal(exportView(rows[0]).url, null);
  assert.equal(rows[0].error, null);
  assert.equal(rows[0].sizeBytes, null);
  assert.equal(framesStarted, false);
  assert.equal(await cancelMovieExport(999), undefined);
});

test("ready and failed exports cannot be cancelled", async () => {
  rows.push(makeJob(1, "ready"), makeJob(2, "failed"));
  assert.equal((await cancelMovieExport(1))?.status, "ready");
  assert.equal((await cancelMovieExport(2))?.status, "failed");
});

test("active frame work cancels, cleans temp files, and does not resurrect on worker wake or retry", async () => {
  const before = new Set((await readdir(tmpdir())).filter(name => name.startsWith("faith-movie-")));
  rows.push(makeJob(1));
  const worker = wakeMovieWorker();
  while (!framesStarted) await new Promise(resolve => setTimeout(resolve, 5));
  // Let actual Sharp frame work begin before cancelling.
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await cancelMovieExport(1))?.status, "cancelled");
  await worker;
  assert.equal(rows[0].status, "cancelled");
  assert.equal(rows[0].error, null);
  assert.equal(rows[0].progress, 0);
  const after = (await readdir(tmpdir())).filter(name => name.startsWith("faith-movie-") && !before.has(name));
  assert.deepEqual(after, []);
  // Retry is a fresh job; cancelling that queued retry leaves the old row intact.
  rows.push(makeJob(2));
  await cancelMovieExport(2);
  await wakeMovieWorker();
  assert.deepEqual(rows.map(row => row.status), ["cancelled", "cancelled"]);
});

test("an encoder abort waits for FFmpeg exit and reports cancellation rather than failure", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled");
  const encoder = runMovieEncoder(["-v", "error", "-re", "-f", "lavfi", "-i", "color=s=1280x720:r=30", "-f", "null", "-"], controller.signal);
  setTimeout(() => controller.abort(reason), 100);
  await assert.rejects(encoder, error => error === reason);
});

test("an already cancelled encoder cannot start", () => {
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => runMovieEncoder([], controller.signal), { name: "AbortError" });
});

test("an oversized entire series fails before rendering and a smaller queued episode completes", async () => {
  largeSeries = true;
  const before = new Set((await readdir(tmpdir())).filter(name => name.startsWith("faith-movie-")));
  rows.push({ ...makeJob(1), episodeId: null }, makeJob(2));
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  mock.method(ObjectStorageService.prototype, "getPrivateObjectDir", () => "/test/private");
  mock.method(objectStorageClient, "bucket", () => ({
    file: () => ({ createWriteStream: () => output }),
  }));
  await wakeMovieWorker();
  assert.equal(rows[0].status, "failed");
  assert.match(rows[0].error!, /2000 storyboard card limit.*one episode/i);
  assert.equal(rows[0].progress, 0);
  assert.equal(rows[0].objectPath, null);
  assert.equal(rows[1].status, "ready");
  assert.equal(rows[1].progress, 100);
  assert.ok(rows[1].objectPath);
  assert.deepEqual((await readdir(tmpdir())).filter(name => name.startsWith("faith-movie-") && !before.has(name)), []);
});

test("oversized reference downloads are destroyed, fail actionably, and leave no temp files", async () => {
  reference = true;
  const before = new Set((await readdir(tmpdir())).filter(name => name.startsWith("faith-movie-")));
  const input = Readable.from([Buffer.alloc(8 * 1024 * 1024), Buffer.alloc(1)]);
  mock.method(ObjectStorageService.prototype, "getObjectEntityFile", async () => ({
    createReadStream: () => input,
  }));
  rows.push(makeJob(1));
  await wakeMovieWorker();
  assert.equal(rows[0].status, "failed");
  assert.match(rows[0].error!, /8 MB per image.*smaller reference/i);
  assert.equal(input.destroyed, true);
  assert.equal(rows[0].objectPath, null);
  assert.deepEqual((await readdir(tmpdir())).filter(name => name.startsWith("faith-movie-") && !before.has(name)), []);
});

test("a timed-out reference download fails the job, cleans up, and lets the next movie finish", async () => {
  largeSeries = true;
  reference = true;
  const before = new Set((await readdir(tmpdir())).filter(name => name.startsWith("faith-movie-")));
  const originalTimeout = globalThis.setTimeout;
  let firstDeadline = true;
  mock.method(globalThis, "setTimeout", (callback: (...args: any[]) => void, ms: number, ...args: any[]) => {
    if (ms === movieLimits.renderMs && firstDeadline) {
      firstDeadline = false;
      return originalTimeout(callback, 100, ...args);
    }
    return originalTimeout(callback, ms, ...args);
  });
  const stalled = new Readable({ read() {} });
  mock.method(ObjectStorageService.prototype, "getObjectEntityFile", async () => ({
    createReadStream: () => { reference = false; return stalled; },
  }));
  mock.method(ObjectStorageService.prototype, "getPrivateObjectDir", () => "/test/private");
  mock.method(objectStorageClient, "bucket", () => ({
    file: () => ({ createWriteStream: () => new Writable({ write(_chunk, _encoding, callback) { callback(); } }) }),
  }));
  rows.push(makeJob(1), makeJob(2));
  await wakeMovieWorker();
  assert.equal(rows[0].status, "failed");
  assert.match(rows[0].error!, /20 minute render limit/);
  assert.equal(stalled.destroyed, true);
  assert.equal(rows[1].status, "ready");
  assert.deepEqual((await readdir(tmpdir())).filter(name => name.startsWith("faith-movie-") && !before.has(name)), []);
});

test("temporary-budget exhaustion cleans partial PNGs and does not block the next movie", async () => {
  largeSeries = true;
  const before = new Set((await readdir(tmpdir())).filter(name => name.startsWith("faith-movie-")));
  const addTemporary = MovieBudget.prototype.addTemporary;
  let files = 0;
  mock.method(MovieBudget.prototype, "addTemporary", function(this: MovieBudget, bytes: number) {
    if (++files === 2) throw this.diskError();
    return addTemporary.call(this, bytes);
  });
  mock.method(ObjectStorageService.prototype, "getPrivateObjectDir", () => "/test/private");
  mock.method(objectStorageClient, "bucket", () => ({
    file: () => ({ createWriteStream: () => new Writable({ write(_chunk, _encoding, callback) { callback(); } }) }),
  }));
  rows.push(makeJob(1), makeJob(2));
  await wakeMovieWorker();
  assert.equal(rows[0].status, "failed");
  assert.match(rows[0].error!, /512 MB temporary storage limit.*720p/);
  assert.equal(rows[0].objectPath, null);
  assert.equal(rows[1].status, "ready");
  assert.deepEqual((await readdir(tmpdir())).filter(name => name.startsWith("faith-movie-") && !before.has(name)), []);
});

test("FFmpeg size-limited output is rejected rather than uploaded as a complete movie", async () => {
  largeSeries = true;
  const before = new Set((await readdir(tmpdir())).filter(name => name.startsWith("faith-movie-")));
  const remaining = Object.getOwnPropertyDescriptor(MovieBudget.prototype, "remainingTemporaryBytes")!.get!;
  const addTemporary = MovieBudget.prototype.addTemporary;
  let files = 0;
  let capNextOutput = false;
  mock.method(MovieBudget.prototype, "addTemporary", function(this: MovieBudget, bytes: number) {
    addTemporary.call(this, bytes);
    // Three PNGs followed by the concat manifest.
    if (++files === 4) capNextOutput = true;
  });
  mock.getter(MovieBudget.prototype, "remainingTemporaryBytes", function(this: MovieBudget) {
    if (capNextOutput) { capNextOutput = false; return 16 * 1024 * 1024 + 1; }
    return remaining.call(this);
  });
  let uploads = 0;
  mock.method(ObjectStorageService.prototype, "getPrivateObjectDir", () => "/test/private");
  mock.method(objectStorageClient, "bucket", () => ({
    file: () => ({
      createWriteStream: () => {
        uploads++;
        return new Writable({ write(_chunk, _encoding, callback) { callback(); } });
      },
    }),
  }));
  rows.push(makeJob(1), makeJob(2));
  await wakeMovieWorker();
  assert.equal(rows[0].status, "failed");
  assert.match(rows[0].error!, /temporary storage limit/);
  assert.equal(rows[0].objectPath, null);
  assert.equal(rows[1].status, "ready");
  assert.equal(uploads, 1);
  assert.deepEqual((await readdir(tmpdir())).filter(name => name.startsWith("faith-movie-") && !before.has(name)), []);
});

function shortDatabaseDeadlines() {
  const timeout = globalThis.setTimeout;
  mock.method(globalThis, "setTimeout", (callback: (...args: any[]) => void, ms: number, ...args: any[]) =>
    timeout(callback, ms === 5000 ? 30 : ms, ...args));
}

function acceptUploads() {
  mock.method(ObjectStorageService.prototype, "getPrivateObjectDir", () => "/test/private");
  mock.method(objectStorageClient, "bucket", () => ({
    file: () => ({ createWriteStream: () => new Writable({ write(_chunk, _encoding, callback) { callback(); } }) }),
  }));
}

for (const failureWriteStalls of [false, true]) {
  test(`a stalled progress write cleans up and advances the queue even when failure reporting ${failureWriteStalls ? "also stalls" : "succeeds"}`, async () => {
    largeSeries = true;
    shortDatabaseDeadlines();
    acceptUploads();
    const before = new Set((await readdir(tmpdir())).filter(name => name.startsWith("faith-movie-")));
    rows.push(makeJob(1), makeJob(2));
    stallWrite = (patch, condition) => {
      if (matches(rows[0], condition) && ((patch.status === undefined && patch.progress! > 0) ||
          (failureWriteStalls && patch.status === "failed"))) return new Promise(() => {});
    };
    await wakeMovieWorker();
    assert.equal(rows[0].status, failureWriteStalls ? "rendering" : "failed");
    if (!failureWriteStalls) assert.match(rows[0].error!, /timed out/);
    assert.equal(rows[0].objectPath, null);
    assert.equal(rows[1].status, "ready");
    assert.deepEqual((await readdir(tmpdir())).filter(name => name.startsWith("faith-movie-") && !before.has(name)), []);
  });
}

test("a late completion response cannot resurrect a timed-out movie or retain its uploaded object", async () => {
  largeSeries = true;
  shortDatabaseDeadlines();
  acceptUploads();
  rows.push(makeJob(1), makeJob(2));
  const before = new Set((await readdir(tmpdir())).filter(name => name.startsWith("faith-movie-")));
  let finishLate!: () => void;
  let uploadedDeletes = 0;
  mock.method(ObjectStorageService.prototype, "getObjectEntityFile", async () => ({
    delete: async () => { uploadedDeletes++; },
  }));
  let delayed = false;
  stallWrite = (patch, condition, apply) => {
    if (patch.status === "ready" && !delayed && matches(rows[0], condition)) {
      delayed = true;
      // Simulate PostgreSQL committing but the network withholding its reply.
      const committed = apply();
      return new Promise(resolve => { finishLate = () => resolve(committed); });
    }
  };
  await wakeMovieWorker();
  assert.equal(rows[0].status, "failed");
  assert.equal(rows[0].objectPath, null);
  assert.equal(rows[1].status, "ready");
  assert.equal(uploadedDeletes, 1);
  finishLate();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rows[0].status, "failed");
  assert.equal(rows[0].objectPath, null);
  assert.deepEqual((await readdir(tmpdir())).filter(name => name.startsWith("faith-movie-") && !before.has(name)), []);
});

test("cancel route validates IDs, returns missing/conflict errors, and is idempotent", async () => {
  const layer = movieRoutes.stack.find(layer => layer.route?.path === "/studio/exports/:id/cancel")!;
  const handler = layer.route!.stack[0].handle;
  const invoke = async (id: string) => {
    let status = 200;
    let body: any;
    const res = {
      status(value: number) { status = value; return res; },
      json(value: unknown) { body = value; },
    };
    await handler({ params: { id } }, res, () => {});
    return { status, body };
  };
  rows.push(makeJob(1), makeJob(2, "ready"), makeJob(3, "failed"));
  assert.equal((await invoke("bad")).status, 400);
  assert.equal((await invoke("999")).status, 404);
  assert.equal((await invoke("2")).status, 409);
  assert.equal((await invoke("3")).status, 409);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await invoke("1");
    assert.equal(response.status, 200);
    assert.equal(response.body.status, "cancelled");
    assert.equal(response.body.url, null);
  }
});

test("aborting an in-progress movie upload destroys its stream and deletes its object", async () => {
  const directory = await mkdtemp(join(tmpdir(), "movie-upload-test-"));
  try {
    const path = join(directory, "movie.mp4");
    await writeFile(path, Buffer.alloc(256 * 1024));
    let started!: () => void;
    const writing = new Promise<void>(resolve => { started = resolve; });
    const output = new Writable({ write(_chunk, _encoding, _callback) { started(); } });
    const deleted: unknown[] = [];
    mock.method(ObjectStorageService.prototype, "getPrivateObjectDir", () => "/test/private");
    mock.method(objectStorageClient, "bucket", () => ({
      file: () => ({
        createWriteStream: () => output,
        delete: async (options: unknown) => { deleted.push(options); },
      }),
    }));
    const controller = new AbortController();
    const upload = storePrivateMedia(path, "mp4", "video/mp4", controller.signal);
    await writing;
    controller.abort();
    await assert.rejects(upload, { name: "AbortError" });
    assert.equal(output.destroyed, true);
    assert.deepEqual(deleted, [{ ignoreNotFound: true }]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
