import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable } from "node:stream";
import { MovieBudget, MovieBudgetError, movieLimits, movieLookup } from "../src/lib/movieBudget";

test("card and temporary budgets include exact boundaries and accumulate across files", () => {
  const budget = new MovieBudget(new AbortController().signal, { ...movieLimits, frames: 3, temporaryBytes: 10 });
  try {
    budget.checkFrames(3);
    assert.throws(() => budget.checkFrames(4), /storyboard card limit/);
    budget.addTemporary(6);
    budget.addTemporary(4);
    assert.equal(budget.remainingTemporaryBytes, 0);
    assert.throws(() => budget.addTemporary(1), /temporary storage limit/);
  } finally { budget.dispose(); }
});

test("reference limits apply without content-length and destroy the download on overflow", async () => {
  const budget = new MovieBudget(new AbortController().signal, { ...movieLimits, referenceBytes: 4, totalReferenceBytes: 6 });
  try {
    assert.deepEqual(await budget.reference(Readable.from([Buffer.from("ab"), Buffer.from("cd")])), Buffer.from("abcd"));
    const second = Readable.from([Buffer.from("ef"), Buffer.from("g")]);
    await assert.rejects(budget.reference(second), MovieBudgetError);
    assert.equal(second.destroyed, true);
    const oversized = Readable.from([Buffer.alloc(5)]);
    await assert.rejects(budget.reference(oversized), MovieBudgetError);
    assert.equal(oversized.destroyed, true);
  } finally { budget.dispose(); }
});

test("a single image cannot exceed its byte cap even when aggregate allowance remains", async () => {
  const budget = new MovieBudget(new AbortController().signal, { ...movieLimits, referenceBytes: 4 });
  try {
    await assert.rejects(budget.reference(Readable.from([Buffer.alloc(4), Buffer.alloc(1)])), MovieBudgetError);
  } finally { budget.dispose(); }
});

test("the whole-render deadline aborts stalled reads before encoding and frees subsequent work", async () => {
  const budget = new MovieBudget(new AbortController().signal, { ...movieLimits, renderMs: 30 });
  const stream = new Readable({ read() {} });
  try {
    await assert.rejects(budget.reference(stream), /abort/i);
    assert.equal(stream.destroyed, true);
    assert.ok(budget.signal.reason instanceof MovieBudgetError);
    assert.match(budget.signal.reason.message, /render limit.*one episode/i);
    const next = new MovieBudget(new AbortController().signal);
    try { assert.equal((await next.reference(Readable.from([Buffer.from("ok")]))).toString(), "ok"); }
    finally { next.dispose(); }
  } finally { budget.dispose(); }
});

test("lookup timeout does not wait forever or leave late rejections unhandled", async () => {
  const budget = new MovieBudget(new AbortController().signal, { ...movieLimits, renderMs: 10 });
  let reject!: (reason: Error) => void;
  const pending = new Promise<never>((_, fail) => { reject = fail; });
  try {
    await assert.rejects(movieLookup(pending, budget.signal), MovieBudgetError);
    reject(new Error("late failure"));
    await new Promise(resolve => setImmediate(resolve));
  } finally { budget.dispose(); }
});

test("deadline cancellation propagates to the actual encoder and waits for its exit", async () => {
  const { runMovieEncoder } = await import("../src/lib/movieWork");
  const budget = new MovieBudget(new AbortController().signal, { ...movieLimits, renderMs: 100 });
  try {
    await assert.rejects(runMovieEncoder([
      "-v", "error", "-re", "-f", "lavfi", "-i", "color=s=16x16:r=2", "-f", "null", "-",
    ], budget.signal), MovieBudgetError);
  } finally { budget.dispose(); }
});

test("invalid and excessively long playback durations cannot reach FFmpeg", () => {
  const budget = new MovieBudget(new AbortController().signal);
  try {
    budget.checkDuration(movieLimits.playbackSeconds);
    for (const duration of [NaN, Infinity, 0, -1, movieLimits.playbackSeconds + 1]) {
      assert.throws(() => budget.checkDuration(duration), MovieBudgetError);
    }
  } finally { budget.dispose(); }
});

test("disposing a completed budget clears its deadline and parent listener", async () => {
  const controller = new AbortController();
  const budget = new MovieBudget(controller.signal, { ...movieLimits, renderMs: 5 });
  budget.dispose();
  controller.abort();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(budget.signal.aborted, false);
});
