import assert from "node:assert/strict";
import { beforeEach, afterEach, mock, test } from "node:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { runMovieEncoder } from "../src/lib/movieWork";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost/unused";
const { db, studioExportsTable, studioProjectsTable, studioEpisodesTable, studioScenesTable } = await import("@workspace/db");
const { cancelMovieExport, wakeMovieWorker, exportView } = await import("../src/lib/movieRenderer");
const { default: movieRoutes } = await import("../src/routes/movieExports");
const { storePrivateMedia } = await import("../src/lib/privateMedia");
const { objectStorageClient, ObjectStorageService } = await import("../src/lib/objectStorage");
type Row = typeof studioExportsTable.$inferSelect;
let rows: Row[];
let framesStarted: boolean;
const dialect = new PgDialect();
const makeJob = (id: number, status: Row["status"] = "queued"): Row => ({
  id, episodeId: 1, status, aspectRatio: "16:9", quality: "720p",
  progress: 0, objectPath: null, error: null, startedAt: null, createdAt: new Date(),
});
// Evaluate the worker's real Drizzle predicates, not hand-written cancellation logic.
function matches(row: Row, condition: SQL) {
  const { sql, params } = dialect.sqlToQuery(condition);
  let matches = true;
  for (const match of sql.matchAll(/"studio_exports"\."(id|status|started_at)"\s*(=|<|in)\s*(\$\d+|\([^)]*\))/g)) {
    const value = row[match[1] === "started_at" ? "startedAt" : match[1] as "id" | "status"];
    const values = [...match[3].matchAll(/\$(\d+)/g)].map(param => params[Number(param[1]) - 1]);
    matches &&= match[2] === "in" ? values.includes(value) : match[2] === "=" ? value === values[0] :
      value instanceof Date && value < (values[0] as Date);
  }
  return matches;
}

beforeEach(() => {
  rows = [];
  framesStarted = false;
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
      const result = table === studioProjectsTable ? [{ title: "Cancellation test" }] :
        table === studioEpisodesTable ? [{ id: 1, number: 1, title: "Test", summary: "Test" }] :
        table === studioScenesTable ? Array.from({ length: 150 }, (_, i) => ({
          id: i + 1, episodeId: 1, number: i + 1, content: "Test card", heading: "Test scene", synopsis: "", duration: "10:00",
        })) : [];
      const query = {
        limit: async () => result,
        orderBy: async () => { framesStarted = true; return result; },
      };
      return query;
    },
  }));
  mock.method(db, "update", () => ({
    set(patch: Partial<Row>) {
      return {
        where(condition: SQL) {
          const changed = rows.filter(row => matches(row, condition));
          changed.forEach(row => Object.assign(row, patch));
          const promise = Promise.resolve(changed.map(row => ({ ...row })));
          return Object.assign(promise, { returning: () => promise });
        },
      };
    },
  }));
});
afterEach(() => mock.restoreAll());

test("queued cancellation is idempotent, hidden from downloads, and excluded from worker recovery", async () => {
  rows.push(makeJob(1));
  assert.equal((await cancelMovieExport(1))?.status, "cancelled");
  assert.equal((await cancelMovieExport(1))?.status, "cancelled");
  await wakeMovieWorker();
  assert.equal(rows[0].status, "cancelled");
  assert.equal(exportView(rows[0]).url, null);
  assert.equal(rows[0].error, null);
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
