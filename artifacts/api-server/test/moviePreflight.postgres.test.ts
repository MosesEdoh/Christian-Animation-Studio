import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, mock, test } from "node:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { pool } from "@workspace/db";
import { estimateMovie, preflightDb } from "../src/lib/moviePreflight";
import { movieLimits } from "../src/lib/movieBudget";
import { moviePageSeconds, movieScenePages } from "../src/lib/movieLayout";

const textBudget = movieLimits.frames * 18 * 48;
const client = await pool.connect();
const query = client.query.bind(client);
const isolatedDb = drizzle(client);
type Read = { kind: "episodes" | "metadata" | "scripts"; sql: string; params: unknown[]; rows: unknown[][] };
let reads: Read[];
let beforeScripts: ((batch: number) => Promise<void>) | undefined;
let pending: Promise<unknown>[];
let reverseScripts: boolean;

before(async () => {
  // A dedicated connection and pg_temp-only search path make even unqualified
  // production queries incapable of reaching the application's saved tables.
  await query("SET search_path TO pg_temp");
  await query("SET statement_timeout TO 7000");
});

beforeEach(async () => {
  await query("BEGIN");
  await query(`
    CREATE TEMP TABLE studio_episodes (
      id integer PRIMARY KEY, number integer NOT NULL, summary text NOT NULL
    ) ON COMMIT DROP;
    CREATE TEMP TABLE studio_scenes (
      id integer PRIMARY KEY, episode_id integer NOT NULL, number integer NOT NULL,
      duration text NOT NULL, content text NOT NULL, synopsis text NOT NULL
    ) ON COMMIT DROP;
    INSERT INTO studio_episodes VALUES (7, 1, 'A short summary.');
  `);
  reads = [];
  pending = [];
  beforeScripts = undefined;
  reverseScripts = false;
  // Redirect only the connection: Drizzle still compiles and executes every
  // production projection, CASE expression, predicate, and LIMIT in PostgreSQL.
  mock.method(preflightDb, "select", isolatedDb.select.bind(isolatedDb));
  mock.method(globalThis, "fetch", () => { throw new Error("Preflight must not download references"); });
  mock.method(client, "query", (config: { text: string; rowMode?: "array" }, params: unknown[]) => {
    assert.equal(config.rowMode, "array", "observe actual Drizzle reads, not fixture writes");
    const kind = config.text.includes("case ") ? "scripts"
      : config.text.includes('"studio_scenes"') ? "metadata" : "episodes";
    const read: Read = { kind, sql: config.text, params, rows: [] };
    reads.push(read);
    const work = (async () => {
      if (kind === "scripts") await beforeScripts?.(scriptReads().length);
      // PostgreSQL itself returns the rows in a deliberately different order.
      // No fabricated result rows or emulated SQL expressions are used.
      const text = kind === "scripts" && reverseScripts
        ? `SELECT * FROM (${config.text}) AS saved ORDER BY id DESC`
        : config.text;
      const result = await query({ ...config, text }, params);
      read.rows = result.rows.map(row => [...row]);
      return result;
    })();
    pending.push(work);
    return work;
  });
});

afterEach(async () => {
  mock.restoreAll();
  // A deadline can return while its read finishes late. Drain it before rolling
  // back so the next fixture never shares outstanding work with the prior one.
  await Promise.allSettled(pending);
  await query("ROLLBACK");
});

after(async () => {
  try {
    await query("RESET search_path");
    await query("RESET statement_timeout");
  } finally {
    client.release();
    await pool.end();
  }
});

const scriptReads = () => reads.filter(read => read.kind === "scripts");
const metadataRead = () => reads.find(read => read.kind === "metadata")!;
async function scene(id: number, content: string, synopsis = "Fallback.", duration = "1") {
  await query(`INSERT INTO studio_scenes VALUES ($1, 7, $1, $2, $3, $4)`,
    [id, duration, content, synopsis]);
}
async function shortScenes(count: number) {
  await query(`INSERT INTO studio_scenes
    SELECT n, 7, n, '1', 'Scene ' || n || '.', 'Fallback.'
    FROM generate_series(1, $1::integer) AS n`, [count]);
}
function assertBounds() {
  let totalCaps = 0;
  let totalText = 0;
  for (const read of reads) {
    assert.doesNotMatch(read.sql, /reference|studio_shots|studio_assets|studio_characters/i);
    assert.match(read.sql, /limit \$\d+/i);
    if (read.kind !== "scripts") {
      assert.equal(read.params.at(-1), movieLimits.frames + 1);
      assert.ok(read.rows.length <= movieLimits.frames + 1);
      continue;
    }
    assert.match(read.sql, /left\(coalesce\(nullif\(.+case "studio_scenes"\."id" /);
    const count = (read.sql.match(/when \$/g) ?? []).length;
    assert.ok(count > 0 && count <= 100);
    assert.equal(read.params.at(-1), count, "SQL LIMIT matches the batch size");
    assert.ok(read.rows.length <= count);
    // First parameter is the bounded length sentinel; CASE id/cap pairs follow.
    assert.equal(read.params[0], textBudget + 1);
    const caps = new Map<number, number>();
    for (let i = 0; i < count; i++) {
      caps.set(Number(read.params[1 + i * 2]), Number(read.params[2 + i * 2]));
    }
    totalCaps += [...caps.values()].reduce((sum, cap) => sum + cap, 0);
    assert.ok(totalCaps <= textBudget, "one allocation budget spans all batches");
    for (const row of read.rows) {
      assert.equal(row.length, 3, "only ID, bounded length, and capped text cross the database boundary");
      const [id, length, text] = row as [number, number, string];
      assert.ok(length <= textBudget + 1);
      const codePoints = Array.from(text).length;
      assert.ok(codePoints <= caps.get(id)!);
      totalText += codePoints;
    }
    assert.ok(totalText <= textBudget, "actual PostgreSQL text payload stays bounded");
  }
}

test("real CASE caps retain uneven scripts, fallback text, and unordered ID mapping in both orientations", async () => {
  const fixtures = [
    { id: 1, content: "Long dialogue ".repeat(5000), synopsis: "Unused", duration: "60" },
    { id: 2, content: "", synopsis: "Fallback dialogue ".repeat(80), duration: "30" },
    { id: 3, content: "Short.", synopsis: "Unused", duration: "10" },
  ];
  for (const row of fixtures) await scene(row.id, row.content, row.synopsis, row.duration);
  // Continue beyond one batch, with the first batch containing unequal caps.
  await query(`INSERT INTO studio_scenes SELECT n, 7, n, '1', 'Short.', ''
    FROM generate_series(4, 101) AS n`);
  reverseScripts = true;
  for (const aspect of ["16:9", "9:16"] as const) {
    reads = [];
    const result = await estimateMovie(7, aspect);
    let cards = 2 + 98;
    let playback = 13;
    for (const row of fixtures) {
      const layout = movieScenePages(row, aspect === "9:16");
      cards += layout.pageCount;
      for (let page = 0; page < layout.pageCount; page++) {
        playback += moviePageSeconds(row.duration, layout.pageCount,
          layout.lines.slice(page * layout.pageSize, (page + 1) * layout.pageSize));
      }
    }
    playback += 98 * 5;
    assert.equal(result?.canQueue, true);
    assert.equal(result?.cards, cards);
    assert.equal(result?.playbackSeconds, playback);
    assert.equal(scriptReads().length, 2);
    assert.deepEqual(scriptReads()[0].rows.map(row => row[0]), Array.from({ length: 100 }, (_, i) => 100 - i));
    assert.equal(scriptReads()[0].rows.find(row => row[0] === 1)![2], fixtures[0].content);
    assert.equal(scriptReads()[0].rows.find(row => row[0] === 2)![2], fixtures[1].synopsis);
    assertBounds();
  }
});

test("PostgreSQL length metadata is capped and oversized text is never fetched", async () => {
  await query(`UPDATE studio_episodes SET summary = repeat('s', 2000000)`);
  await scene(1, "x".repeat(textBudget * 2));
  const result = await estimateMovie(7, "16:9");
  assert.equal(result?.canQueue, false);
  assert.match(result!.message, /Movie script text is too large/);
  assert.equal((reads[0].rows[0][1] as string).length, 850);
  assert.deepEqual(metadataRead().rows, [[1, 7, "1", textBudget + 1]]);
  assert.equal(scriptReads().length, 0);
  assertBounds();
  // Once the summary fits, the bounded scene-length sentinel itself blocks
  // the estimate without transferring the oversized saved content.
  await query("UPDATE studio_episodes SET summary = 'Short summary.'");
  reads = [];
  assert.match((await estimateMovie(7, "16:9"))!.message, /saved script text exceeds/);
  assert.deepEqual(metadataRead().rows, [[1, 7, "1", textBudget + 1]]);
  assert.equal(scriptReads().length, 0);
  assertBounds();
});

test("aggregate overflow across 101 scenes blocks before any script text read", async () => {
  await query(`INSERT INTO studio_scenes SELECT n, 7, n, '1', repeat('x', $1), ''
    FROM generate_series(1, 101) AS n`, [Math.ceil(textBudget / 101)]);
  const result = await estimateMovie(7, "9:16");
  assert.equal(result?.canQueue, false);
  assert.match(result!.message, /saved script text exceeds/);
  assert.equal(reads.length, 2);
  assert.equal(scriptReads().length, 0);
  assertBounds();
});

test("the exact aggregate text allowance is shared across two real batches", async () => {
  // Whitespace consumes the text budget but collapses during layout, so this
  // boundary reaches both batches instead of hitting card/playback limits.
  await query(`INSERT INTO studio_scenes SELECT n, 7, n, '1',
    repeat(' ', CASE WHEN n = 101 THEN $1::integer - 100 * 17000 ELSE 17000 END), ''
    FROM generate_series(1, 101) AS n`, [textBudget]);
  const result = await estimateMovie(7, "16:9");
  assert.equal(result?.canQueue, true);
  assert.equal(result?.cards, 103);
  assert.equal(scriptReads().length, 2);
  assert.equal(scriptReads().flatMap(read => read.rows).reduce((sum, row) => sum + (row[2] as string).length, 0), textBudget);
  assertBounds();
});

test("growth between metadata and text reads is capped per ID and rejected", async () => {
  await scene(1, "Tiny.");
  await scene(2, "A longer original script.");
  beforeScripts = async () => {
    await query("UPDATE studio_scenes SET content = repeat('z', $1) WHERE id = 1", [textBudget * 2]);
  };
  const result = await estimateMovie(7, "16:9");
  assert.equal(result?.canQueue, false);
  assert.match(result!.message, /script changed.*Check again/);
  assert.deepEqual(scriptReads()[0].rows.find(row => row[0] === 1), [1, textBudget + 1, "zzzzz"]);
  assert.equal(scriptReads()[0].rows.find(row => row[0] === 2)![2], "A longer original script.");
  assertBounds();
});

test("a row deleted before the second batch rejects rather than silently omitting a scene", async () => {
  await shortScenes(201);
  beforeScripts = async batch => {
    if (batch === 2) await query("DELETE FROM studio_scenes WHERE id = $1", [101]);
  };
  const result = await estimateMovie(7, "16:9");
  assert.equal(result?.canQueue, false);
  assert.match(result!.message, /script changed.*Check again/);
  assert.equal(scriptReads().length, 2, "never fetch the third batch after a missing row");
  assert.equal(scriptReads()[1].rows.length, 99);
  assertBounds();
});

test("PostgreSQL code-point lengths do not bypass the stricter aggregate JS allowance", async () => {
  const perScene = Math.floor(textBudget / 101);
  await query(`INSERT INTO studio_scenes SELECT n, 7, n, '1',
    repeat(' ', CASE WHEN n = 1 THEN $1::integer - 2 ELSE $1::integer END) ||
      CASE WHEN n = 1 THEN '😀' ELSE '' END, ''
    FROM generate_series(1, 101) AS n`, [perScene]);
  // Grow the final scene's cap to make PG total exactly the budget; JS counts
  // the emoji as two units and must reject that extra unit in the second batch.
  await query("UPDATE studio_scenes SET content = content || repeat(' ', $1) WHERE id = 101",
    [textBudget - (101 * perScene - 1)]);
  const result = await estimateMovie(7, "9:16");
  assert.equal(result?.canQueue, false);
  assert.match(result!.message, /saved script text exceeds/);
  assert.equal(scriptReads().length, 2);
  assert.equal(metadataRead().rows.reduce((sum, row) => sum + Number(row[3]), 0), textBudget);
  assertBounds();
});

test("missing episodes and episodes without scenes stay distinct", async () => {
  assert.equal(await estimateMovie(999, "16:9"), null);
  assert.match((await estimateMovie(7, "16:9"))!.message, /complete each selected episode/);
  assert.equal(scriptReads().length, 0);
  assertBounds();
});

test("real metadata queries keep episode and scene row limits", async () => {
  await query("DELETE FROM studio_episodes");
  await query(`INSERT INTO studio_episodes SELECT n, n, '' FROM generate_series(1, 2500) AS n`);
  assert.match((await estimateMovie(undefined, "16:9"))!.message, /2000 storyboard card limit/);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].rows.length, 2001);
  assertBounds();
  await query("DELETE FROM studio_episodes");
  await query("INSERT INTO studio_episodes VALUES (7, 1, '')");
  await shortScenes(2500);
  reads = [];
  assert.match((await estimateMovie(7, "16:9"))!.message, /2000 storyboard card limit/);
  assert.equal(metadataRead().rows.length, 2001);
  assert.equal(scriptReads().length, 0);
  assertBounds();
});

test("1990 real scenes fit at the card limit using only twenty bounded script reads", async () => {
  await query("DELETE FROM studio_episodes");
  await query("INSERT INTO studio_episodes SELECT n, n, '' FROM generate_series(1, 9) AS n");
  await shortScenes(1990);
  await query("UPDATE studio_scenes SET episode_id = (id % 9) + 1");
  const started = performance.now();
  const result = await estimateMovie(undefined, "16:9");
  assert.equal(result?.canQueue, true);
  assert.equal(result?.cards, 2000);
  assert.equal(result?.playbackSeconds, 9 * 6 + 7 + 1990 * 5);
  assert.ok(performance.now() - started < 5000);
  assert.equal(reads.length, 22);
  assert.equal(scriptReads().length, 20);
  assert.equal(scriptReads().at(-1)!.rows.length, 90);
  assertBounds();
});

test("real delayed database reads share one five-second overall deadline", { timeout: 12_000 }, async () => {
  await shortScenes(201);
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const timeouts = mock.method(AbortSignal, "timeout", (ms: number) => {
    assert.equal(ms, 5000);
    return timeout(ms);
  });
  beforeScripts = async batch => {
    // Each delay individually fits, but their total exceeds the single deadline.
    await query("SELECT pg_sleep($1)", [batch === 1 ? 2 : 4]);
  };
  const started = performance.now();
  await assert.rejects(estimateMovie(7, "16:9"), { name: "TimeoutError" });
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 4500 && elapsed < 5800, `overall deadline elapsed ${elapsed}ms`);
  assert.equal(timeouts.mock.callCount(), 1);
  assert.equal(scriptReads().length, 2, "no third batch starts after timeout");
  await Promise.all(pending);
  assertBounds();
});
