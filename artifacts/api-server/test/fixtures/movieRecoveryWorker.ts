// Bundled by the regression with only unrelated services replaced. The storage,
// renderer lifecycle, and API entry point below are the production modules.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MovieTemporaryStorage } from "../../src/lib/movieTemporaryStorage";
import { startMovieTemporaryRecovery, stopMovieWorker } from "../../src/lib/movieRenderer";

const root = process.env.TMPDIR!;
assert.ok(root, "A private temporary root is required");
const send = (message: Record<string, unknown>) => process.send!(message);

if (process.env.RECOVERY_TEST_MODE === "owner") {
  const storage = new MovieTemporaryStorage();
  const directory = await storage.create();
  try {
    await writeFile(join(directory, "movie.mp4"), "unfinished render");
    send({ kind: "owned", directory, pid: process.pid });
    await new Promise<void>(resolve => {
      process.once("message", message => {
        assert.deepEqual(message, { command: "release" });
        resolve();
      });
    });
  } finally {
    await writeFile(join(root, `finally-${process.pid}`), "ran");
    await storage.remove(directory);
  }
  process.disconnect!();
} else {
  let now = process.env.RECOVERY_TEST_NOW ? Number(process.env.RECOVERY_TEST_NOW) : Date.now();
  assert.ok(Number.isFinite(now));
  Date.now = () => now;
  let nextTimer = 0;
  const timers = new Map<number, { callback: () => void; ms: number; unrefs: number }>();
  // Time only advances on IPC commands: no real five/thirty-minute waits.
  globalThis.setInterval = ((callback: () => void, ms: number) => {
    const id = ++nextTimer;
    const timer = { callback, ms, unrefs: 0 };
    timers.set(id, timer);
    return { unref() { timer.unrefs++; }, id };
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((timer: { id: number }) => {
    timers.delete(timer.id);
  }) as unknown as typeof clearInterval;

  const recover = MovieTemporaryStorage.prototype.recover;
  MovieTemporaryStorage.prototype.recover = function (onError, time) {
    return recover.call(this, onError, time).then(removed => {
      send({ kind: "scan", removed, now, pid: process.pid });
      return removed;
    }, error => {
      send({ kind: "scan-error", error: String(error) });
      throw error;
    });
  };
  const timerView = () => [...timers.values()].map(({ ms, unrefs }) => ({ ms, unrefs }));
  // Import the actual entry point: its listen callback must initiate recovery.
  await import("../../src/index");
  send({ kind: "imported" });

  process.on("message", async (message: { command: string; now?: number }) => {
    try {
      if (message.command === "state") {
        send({ kind: "state", timers: timerView(), created: nextTimer });
      } else if (message.command === "start-again") {
        startMovieTemporaryRecovery();
        send({ kind: "state", timers: timerView(), created: nextTimer });
      } else if (message.command === "tick") {
        now = message.now!;
        const recovery = [...timers.values()].filter(timer => timer.ms === 5 * 60_000);
        assert.equal(recovery.length, 1, "Exactly one scheduled recovery callback");
        recovery[0].callback();
      } else if (message.command === "stop") {
        await stopMovieWorker();
        startMovieTemporaryRecovery();
        send({ kind: "stopped", timers: timerView(), created: nextTimer });
      } else {
        assert.fail(`Unknown command: ${message.command}`);
      }
    } catch (error) {
      send({ kind: "worker-error", error: String(error) });
      process.exitCode = 1;
    }
  });
}
