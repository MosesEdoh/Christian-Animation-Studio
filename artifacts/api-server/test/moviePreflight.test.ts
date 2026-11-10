import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import express from "express";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { hashTrustedDeviceToken } from "../src/lib/trustedDevice";
import { clerkSession } from "./helpers/clerkSession";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost/unused";
const { db, studioEpisodesTable, studioScenesTable, studioTrustedDevicesTable, usersTable } = await import("@workspace/db");
const { preflightDb, estimateMovie } = await import("../src/lib/moviePreflight");
const { default: routes } = await import("../src/routes/index");
const { movieScenePages, moviePageSeconds } = await import("../src/lib/movieLayout");
const { movieLimits } = await import("../src/lib/movieBudget");
const textBudget = movieLimits.frames * 18 * 48;
const dialect = new PgDialect();
const deviceToken = "d".repeat(43);
const deviceTokenHash = hashTrustedDeviceToken(deviceToken);
let episodes: { id: number; summary: string }[];
let scenes: { id: number; episodeId: number; duration: string; text: string }[];
let signedIn: boolean;
let trustedDevice: boolean;
let reads: number;
let fail: boolean;
let readDelayMs: number;
let allocatedText: number;
let textReads: number;
let fetchedScripts: Map<number, string>;
let beforeTextRead: (() => void) | undefined;
// Model PostgreSQL length/left, not JS UTF-16 length/slice.
const length = (text: string) => Array.from(text).length;

beforeEach(() => {
  mock.method(db, "select", () => ({
    from: (table: unknown) => ({
      where: (predicate?: SQL) => ({
        limit: async () => {
          if (table === usersTable) return [{ id: "creator" }];
          if (table === studioTrustedDevicesTable) {
            return predicate && dialect.sqlToQuery(predicate).params[0] === deviceTokenHash ? [{ id: 1 }] : [];
          }
          return [];
        },
      }),
    }),
  }));
  episodes = [{ id: 7, summary: "A short summary." }];
  scenes = [{ id: 1, episodeId: 7, duration: "1:00", text: "Hello world." }];
  signedIn = trustedDevice = true;
  reads = 0; fail = false;
  readDelayMs = allocatedText = textReads = 0;
  fetchedScripts = new Map();
  beforeTextRead = undefined;
  mock.method(preflightDb, "select", (projection: Record<string, unknown>) => ({
    from: (table: unknown) => ({
      where: (predicate?: SQL) => {
        const values = predicate ? dialect.sqlToQuery(predicate).params : [];
        const limit = async (count: number) => {
          reads++;
          if (fail) throw new Error("Database unavailable");
          if (readDelayMs) await new Promise(resolve => setTimeout(resolve, readDelayMs));
          if (table === studioEpisodesTable) return episodes.filter(row => !values.length || values.includes(row.id)).slice(0, count);
          assert.equal(table, studioScenesTable);
          if ("text" in projection) {
            textReads++;
            beforeTextRead?.();
            const params = dialect.sqlToQuery(projection.text as SQL).params;
            const caps = new Map<number, number>();
            for (let index = 0; index < params.length; index += 2) {
              caps.set(Number(params[index]), Number(params[index + 1]));
            }
            assert.ok(count <= 100, "script batch has a strict row bound");
            assert.equal(caps.size, count);
            allocatedText += [...caps.values()].reduce((sum, cap) => sum + cap, 0);
            assert.ok(allocatedText <= textBudget, "aggregate text caps stay within one budget across all batches");
            assert.deepEqual(Object.keys(projection).sort(), ["id", "scriptLength", "text"], "never fetch reference URLs or files");
            return scenes.filter(row => values.includes(row.id)).slice(0, count).reverse().map(row => {
              const text = Array.from(row.text).slice(0, caps.get(row.id) ?? 0).join("");
              fetchedScripts.set(row.id, text);
              return {
                id: row.id,
                scriptLength: Math.min(length(row.text), textBudget + 1),
                text,
              };
            });
          }
          assert.equal(count, movieLimits.frames + 1);
          return scenes.filter(row => values.includes(row.episodeId)).slice(0, count).map(row => ({
            ...row, scriptLength: Math.min(length(row.text), textBudget + 1),
          }));
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

test("many short scenes fit within the original deadline using bounded batches", async () => {
  mock.method(globalThis, "fetch", () => { throw new Error("Preflight must not download references"); });
  episodes = Array.from({ length: 9 }, (_, index) => ({ id: index + 1, summary: "An episode." }));
  scenes = Array.from({ length: 1990 }, (_, index) => ({
    id: index + 1, episodeId: index % 9 + 1, duration: "1", text: `Scene ${index + 1}.`,
  }));
  // Per-scene reads would need over 15 seconds; batches need just 22 reads.
  readDelayMs = 8;
  const result = await estimateMovie(undefined, "16:9");
  assert.equal(result?.canQueue, true);
  assert.equal(result?.cards, 2000);
  assert.equal(result?.playbackSeconds, 9 * 6 + 7 + 1990 * 5);
  assert.equal(textReads, 20);
  assert.equal(reads, 22);
});

test("rejects aggregate text overflow before fetching any scene scripts", async () => {
  scenes = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1, episodeId: 7, duration: "1", text: "a".repeat(Math.floor(textBudget / 100) + 1),
  }));
  const result = await estimateMovie(7, "16:9");
  assert.equal(result?.canQueue, false);
  assert.match(result!.message, /saved script text exceeds/);
  assert.equal(reads, 2);
  assert.equal(textReads, 0);
});

test("rejects oversized scene metadata without reading script content", async () => {
  scenes = Array.from({ length: 2001 }, (_, index) => ({
    id: index + 1, episodeId: 7, duration: "1", text: "Short.",
  }));
  const result = await estimateMovie(7, "16:9");
  assert.equal(result?.canQueue, false);
  assert.match(result!.message, /2000 storyboard card limit/);
  assert.equal(reads, 2);
  assert.equal(textReads, 0);
});

test("text caps accommodate uneven scene lengths without truncating a valid script", async () => {
  scenes = Array.from({ length: 101 }, (_, index) => ({
    id: index + 1, episodeId: 7, duration: "1", text: index === 0 ? "Long dialogue ".repeat(5000) : "Short.",
  }));
  for (const aspectRatio of ["16:9", "9:16"] as const) {
    allocatedText = 0;
    const result = await estimateMovie(7, aspectRatio);
    const layout = movieScenePages({ content: scenes[0]!.text, synopsis: "" }, aspectRatio === "9:16");
    assert.equal(result?.canQueue, true);
    assert.equal(result?.cards, 102 + layout.pageCount);
    assert.equal(allocatedText, scenes.reduce((total, scene) => total + length(scene.text), 0));
  }
});

test("rejects growing or deleted scripts rather than estimating capped or missing text", async () => {
  for (const change of [() => { scenes[0]!.text += " More dialogue."; }, () => { scenes = []; }]) {
    scenes = [{ id: 1, episodeId: 7, duration: "1", text: "Original." }];
    beforeTextRead = change;
    const result = await estimateMovie(7, "16:9");
    assert.equal(result?.canQueue, false);
    assert.match(result!.message, /script changed.*Check again/);
    allocatedText = 0;
  }
});

function rendererEstimate(portrait: boolean) {
  let cards = episodes.length + 1;
  let playbackSeconds = episodes.length * 6 + 7;
  for (const scene of scenes) {
    const layout = movieScenePages({ content: scene.text, synopsis: "" }, portrait);
    cards += layout.pageCount;
    for (let page = 0; page < layout.pageCount; page++) {
      playbackSeconds += moviePageSeconds(scene.duration, layout.pageCount,
        layout.lines.slice(page * layout.pageSize, (page + 1) * layout.pageSize));
    }
  }
  return { cards, playbackSeconds };
}

function assertCompleteScripts() {
  assert.equal(fetchedScripts.size, scenes.length);
  for (const scene of scenes) {
    assert.equal(fetchedScripts.get(scene.id), scene.text, `scene ${scene.id} retains every code point`);
  }
  const codePoints = scenes.reduce((sum, scene) => sum + length(scene.text), 0);
  const utf16Units = scenes.reduce((sum, scene) => sum + scene.text.length, 0);
  assert.equal(allocatedText, codePoints, "caps allocate code points, not UTF-16 units");
  assert.ok(allocatedText <= textBudget, "one fetch allowance covers every batch");
  assert.ok(utf16Units <= allocatedText * 2, "even supplementary characters have a bounded UTF-16 payload");
}

for (const aspectRatio of ["16:9", "9:16"] as const) {
  const portrait = aspectRatio === "9:16";
  const width = portrait ? 46 : 43;
  const pageSize = portrait ? 18 : 13;

  test(`${aspectRatio}: multilingual and emoji dialogue survives three batches at wrap and page boundaries`, async () => {
    const dialogue = [
      "神は愛です。平安がありますように。",
      "السلام عليكم ورحمة الله",
      "नमस्ते दुनिया",
      "cafe\u0301, espérance et paix",
      "👨‍👩‍👧‍👦 🙏🏽 ❤️ 😀🚀",
    ];
    scenes = Array.from({ length: 201 }, (_, index) => ({
      id: index + 1, episodeId: 7, duration: "1",
      text: dialogue[index % dialogue.length]!.repeat(index % 7 + 1),
    }));
    // Put boundary cases on both sides of the 100-row batch transitions.
    for (const [index, units] of [[0, width - 1], [99, width], [100, width + 1]] as const) {
      const text = "😀".repeat(Math.floor(units / 2)) + (units % 2 ? "祈" : "");
      scenes[index]!.text = text;
      assert.equal(text.length, units);
      assert.equal(movieScenePages({ content: text, synopsis: "" }, portrait).lines.length, units > width ? 2 : 1);
    }
    for (const [index, lineCount] of [[98, pageSize - 1], [199, pageSize], [200, pageSize + 1]] as const) {
      scenes[index]!.text = Array(lineCount).fill("祈り🙏🏽").join("\n");
      assert.equal(movieScenePages({ content: scenes[index]!.text, synopsis: "" }, portrait).pageCount,
        lineCount > pageSize ? 2 : 1);
    }
    const expected = rendererEstimate(portrait);
    const result = await estimateMovie(7, aspectRatio);
    assert.equal(result?.canQueue, true);
    assert.equal(result?.cards, expected.cards);
    assert.equal(result?.playbackSeconds, expected.playbackSeconds);
    assert.equal(textReads, 3);
    assert.equal(reads, 5);
    assertCompleteScripts();
    assert.ok(scenes.some(scene => scene.text.length > length(scene.text)));
  });

  for (const extra of [0, 1]) {
    test(`${aspectRatio}: multilingual dialogue ${extra ? "above" : "at"} the card limit agrees with layout across batches`, async () => {
      scenes = Array.from({ length: 101 }, (_, index) => ({
        id: index + 1, episodeId: 7, duration: "1", text: "سلام🙏",
      }));
      const finalPages = movieLimits.frames - 2 - 100;
      scenes[100]!.text = Array(finalPages * pageSize + extra).fill("祈り🙏🏽").join("\n");
      const expected = rendererEstimate(portrait);
      assert.equal(expected.cards, movieLimits.frames + extra);
      assert.ok(expected.playbackSeconds < movieLimits.playbackSeconds);
      const result = await estimateMovie(7, aspectRatio);
      assert.equal(result?.canQueue, extra === 0);
      if (extra) {
        assert.match(result!.message, /2000 storyboard card limit/);
        assert.match(result!.message, /Nothing will be split or shortened automatically/);
      } else {
        assert.equal(result?.cards, expected.cards);
        assert.equal(result?.playbackSeconds, expected.playbackSeconds);
      }
      assert.equal(textReads, 2);
      assertCompleteScripts();
    });

    test(`${aspectRatio}: emoji dialogue ${extra ? "above" : "at"} the playback limit agrees with layout across batches`, async () => {
      scenes = Array.from({ length: 101 }, (_, index) => ({
        id: index + 1, episodeId: 7, duration: "1", text: "祈り🙏",
      }));
      scenes[100]!.duration = String(movieLimits.playbackSeconds - 13 - 100 * 5 + extra);
      const expected = rendererEstimate(portrait);
      assert.equal(expected.playbackSeconds, movieLimits.playbackSeconds + extra);
      const result = await estimateMovie(7, aspectRatio);
      assert.equal(result?.canQueue, extra === 0);
      if (extra) {
        assert.match(result!.message, /6 hour playback limit/);
        assert.match(result!.message, /Nothing will be split or shortened automatically/);
      } else {
        assert.equal(result?.cards, expected.cards);
        assert.equal(result?.playbackSeconds, expected.playbackSeconds);
      }
      assert.equal(textReads, 2);
      assertCompleteScripts();
    });

    test(`${aspectRatio}: aggregate UTF-16 text ${extra ? "above" : "at"} the allowance cannot hide behind smaller code-point caps`, async () => {
      const prefix = "你好 مرحبا cafe\u0301 " + "😀🚀🙏🏽".repeat(24);
      scenes = Array.from({ length: 101 }, (_, index) => {
        const units = index === 100 ? textBudget - 100 * 17000 + extra : 17000;
        return {
          id: index + 1, episodeId: 7, duration: "1",
          // Padding consumes the text allowance without hitting card/time limits.
          text: prefix + " ".repeat(units - prefix.length),
        };
      });
      assert.equal(scenes.reduce((sum, scene) => sum + scene.text.length, 0), textBudget + extra);
      assert.ok(scenes.reduce((sum, scene) => sum + length(scene.text), 0) < textBudget);
      const expected = rendererEstimate(portrait);
      assert.ok(expected.cards < movieLimits.frames);
      assert.ok(expected.playbackSeconds < movieLimits.playbackSeconds);
      const result = await estimateMovie(7, aspectRatio);
      assert.equal(result?.canQueue, extra === 0);
      if (extra) {
        assert.match(result!.message, /saved script text exceeds the bounded movie estimate/);
        assert.match(result!.message, /Nothing will be split or shortened automatically/);
      } else {
        assert.equal(result?.cards, expected.cards);
        assert.equal(result?.playbackSeconds, expected.playbackSeconds);
      }
      assert.equal(textReads, 2, "UTF-16 exhaustion occurs in the second batch");
      assertCompleteScripts();
    });

    test(`${aspectRatio}: per-scene UTF-16 text ${extra ? "above" : "at"} the layout guard is never silently shortened`, async () => {
      scenes = Array.from({ length: 101 }, (_, index) => ({
        id: index + 1, episodeId: 7, duration: "1", text: "",
      }));
      const units = movieLimits.frames * 18 * (width + 2) + extra;
      const prefix = "你好 مرحبا cafe\u0301 " + "😀".repeat(32);
      scenes[100]!.text = prefix + " ".repeat(units - prefix.length);
      assert.ok(length(scenes[100]!.text) < textBudget, "PG metadata alone admits the script");
      const result = await estimateMovie(7, aspectRatio);
      assert.equal(result?.canQueue, extra === 0);
      if (extra) {
        assert.throws(() => rendererEstimate(portrait), /Movie script text is too large/);
        // Portrait reaches the aggregate JS guard first; landscape reaches wrapMovieText.
        assert.match(result!.message, /script text (?:is too large|exceeds)/);
        assert.match(result!.message, /Nothing will be split or shortened automatically/);
      } else {
        const expected = rendererEstimate(portrait);
        assert.equal(result?.cards, expected.cards);
        assert.equal(result?.playbackSeconds, expected.playbackSeconds);
      }
      assert.equal(textReads, 2);
      assertCompleteScripts();
    });
  }

  test(`${aspectRatio}: emoji growth in the second batch rejects capped dialogue and stops further reads`, async () => {
    scenes = Array.from({ length: 201 }, (_, index) => ({
      id: index + 1, episodeId: 7, duration: "1", text: "你好🙏",
    }));
    const original = scenes[100]!.text;
    beforeTextRead = () => {
      if (textReads === 2) scenes[100]!.text += "👨‍👩‍👧‍👦".repeat(1000);
    };
    const result = await estimateMovie(7, aspectRatio);
    assert.equal(result?.canQueue, false);
    assert.match(result!.message, /script changed.*Check again/);
    assert.equal(fetchedScripts.get(101), original, "SQL left caps the changed row at its original code-point length");
    assert.notEqual(fetchedScripts.get(101), scenes[100]!.text);
    assert.equal(textReads, 2, "never fetch the third batch after discovering truncated dialogue");
    assert.equal(allocatedText, 200 * length(original));
    assert.ok(allocatedText <= textBudget);
  });
}

test("all batches share the five-second deadline and stop on cancellation", async () => {
  const controller = new AbortController();
  const timeout = mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    assert.equal(milliseconds, 5000);
    return controller.signal;
  });
  scenes = Array.from({ length: 201 }, (_, index) => ({
    id: index + 1, episodeId: 7, duration: "1", text: "Short.",
  }));
  beforeTextRead = () => {
    if (textReads === 2) controller.abort(new Error("Overall deadline expired"));
  };
  await assert.rejects(estimateMovie(7, "16:9"), /Overall deadline expired/);
  assert.equal(timeout.mock.callCount(), 1);
  assert.equal(textReads, 2);
  assert.equal(reads, 4);
});

async function request(query: string) {
  const app = express();
  app.use((req, _res, next) => {
    Object.assign(req, clerkSession(signedIn ? { userId: "creator", email: "any@example.test" } : null));
    if (trustedDevice) req.headers["x-studio-device"] = deviceToken;
    req.log = { warn() {} } as typeof req.log;
    next();
  });
  app.use("/api", routes);
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>(resolve => server.once("listening", resolve));
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/studio/exports/preflight?${query}`);
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
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
  signedIn = true; trustedDevice = false;
  assert.equal((await request("aspectRatio=16:9")).status, 403);
  assert.equal(reads, 0);
});
