import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import express from "express";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost/unused";
const { studioEpisodesTable, studioScenesTable } = await import("@workspace/db");
const { preflightDb, estimateMovie } = await import("../src/lib/moviePreflight");
const { default: routes } = await import("../src/routes/index");
const { movieScenePages, moviePageSeconds } = await import("../src/lib/movieLayout");
const dialect = new PgDialect();
let episodes: { id: number; summary: string }[];
let scenes: { id: number; episodeId: number; duration: string; text: string }[];
let signedIn: boolean;
let approved: boolean;
let reads: number;
let fail: boolean;

beforeEach(() => {
  episodes = [{ id: 7, summary: "A short summary." }];
  scenes = [{ id: 1, episodeId: 7, duration: "1:00", text: "Hello world." }];
  signedIn = approved = true;
  reads = 0; fail = false;
  mock.method(preflightDb, "select", (projection: Record<string, unknown>) => ({
    from: (table: unknown) => ({
      where: (predicate?: SQL) => {
        const values = predicate ? dialect.sqlToQuery(predicate).params : [];
        const limit = async (count: number) => {
          reads++;
          if (fail) throw new Error("Database unavailable");
          if (table === studioEpisodesTable) return episodes.filter(row => !values.length || values.includes(row.id)).slice(0, count);
          assert.equal(table, studioScenesTable);
          if ("text" in projection) {
            const cap = Number(dialect.sqlToQuery(projection.text as SQL).params.at(-1));
            return scenes.filter(row => values.includes(row.id)).slice(0, count).map(row => ({ text: row.text.slice(0, cap) }));
          }
          return scenes.filter(row => values.includes(row.episodeId)).slice(0, count);
        };
        return { limit, orderBy: () => ({ limit }) };
      },
    }),
  }));
});
afterEach(() => mock.restoreAll());

test("includes opening and closing cards and matches renderer page timing in both orientations", async () => {
  scenes[0]!.text = "Readable dialogue ".repeat(250);
  for (const aspectRatio of ["16:9", "9:16"] as const) {
    const result = await estimateMovie(7, aspectRatio);
    const layout = movieScenePages({ content: scenes[0]!.text, synopsis: "" }, aspectRatio === "9:16");
    let duration = 13;
    for (let page = 0; page < layout.pageCount; page++) {
      duration += moviePageSeconds("1:00", layout.pageCount, layout.lines.slice(page * layout.pageSize, (page + 1) * layout.pageSize));
    }
    assert.equal(result?.cards, layout.pageCount + 2);
    assert.equal(result?.playbackSeconds, duration);
    assert.equal(result?.canQueue, true);
  }
});

test("checks entire-series accumulation but lets individual episodes fit", async () => {
  episodes.push({ id: 8, summary: "Second episode." });
  scenes[0]!.duration = "3:00:00";
  scenes.push({ id: 2, episodeId: 8, duration: "3:00:00", text: "Another scene." });
  const result = await estimateMovie(undefined, "16:9");
  assert.equal(result?.canQueue, false);
  assert.match(result!.message, /Entire series.*6 hour.*export episodes separately/i);
  assert.equal((await estimateMovie(7, "16:9"))?.canQueue, true);
});

test("single-episode playback failure advises an explicit script edit", async () => {
  scenes[0]!.duration = "6:00:00";
  const result = await estimateMovie(7, "9:16");
  assert.equal(result?.canQueue, false);
  assert.match(result!.message, /This episode.*6 hour.*Shorten this episode/i);
  assert.match(result!.message, /Nothing will be split or shortened automatically/);
});

test("accepts exactly the playback limit and rejects immediately above it", async () => {
  scenes[0]!.duration = String(21600 - 13);
  assert.equal((await estimateMovie(7, "16:9"))?.canQueue, true);
  scenes[0]!.duration = String(21600 - 12);
  assert.equal((await estimateMovie(7, "16:9"))?.canQueue, false);
});

test("accepts exactly the card limit and rejects an extra page", async () => {
  scenes[0]!.text = Array(1998 * 13).fill("a").join("\n");
  scenes[0]!.duration = "1";
  assert.equal((await estimateMovie(7, "16:9"))?.cards, 2000);
  scenes[0]!.text += "\na";
  const result = await estimateMovie(7, "16:9");
  assert.equal(result?.canQueue, false);
  assert.match(result!.message, /2000 storyboard card limit/);
});

test("rejects oversized series metadata without reading script content", async () => {
  episodes = Array.from({ length: 2001 }, (_, index) => ({ id: index + 1, summary: "" }));
  assert.equal((await estimateMovie(undefined, "16:9"))?.canQueue, false);
  assert.equal(reads, 1);
});

test("bounds large script text and handles missing or incomplete episodes", async () => {
  scenes[0]!.text = "x".repeat(2_000_000);
  assert.equal((await estimateMovie(7, "16:9"))?.canQueue, false);
  scenes = [];
  assert.match((await estimateMovie(7, "16:9"))!.message, /complete each selected episode/);
  assert.equal(await estimateMovie(999, "16:9"), null);
});

async function request(query: string) {
  const app = express();
  app.use((req, _res, next) => {
    req.isAuthenticated = (() => signedIn) as typeof req.isAuthenticated;
    req.user = { email: approved ? "allowed@example.test" : "denied@example.test" } as typeof req.user;
    req.log = { warn() {} } as typeof req.log;
    next();
  });
  const saved = process.env.STUDIO_ALLOWED_EMAILS;
  process.env.STUDIO_ALLOWED_EMAILS = "allowed@example.test";
  app.use("/api", routes);
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>(resolve => server.once("listening", resolve));
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/studio/exports/preflight?${query}`);
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (saved === undefined) delete process.env.STUDIO_ALLOWED_EMAILS;
    else process.env.STUDIO_ALLOWED_EMAILS = saved;
  }
}

test("route validates selection, supports series and episodes, and returns actionable failures", async () => {
  assert.equal((await request("aspectRatio=16:9")).body.canQueue, true);
  assert.equal((await request("episodeId=7&aspectRatio=9:16")).status, 200);
  for (const query of ["", "episodeId=0&aspectRatio=16:9", "episodeId=1.5&aspectRatio=16:9", "aspectRatio=bad"]) {
    assert.equal((await request(query)).status, 400);
  }
  assert.equal((await request("episodeId=999&aspectRatio=16:9")).status, 404);
  fail = true;
  assert.equal((await request("aspectRatio=16:9")).status, 503);
});

test("preflight uses the same parent access guard as movie exports", async () => {
  signedIn = false;
  assert.equal((await request("aspectRatio=16:9")).status, 401);
  signedIn = true; approved = false;
  assert.equal((await request("aspectRatio=16:9")).status, 403);
  assert.equal(reads, 0);
});
