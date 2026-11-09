import { spawn } from "node:child_process";
import type { Sharp } from "sharp";

// Wait for native image work to settle before the caller removes its directory.
export async function movieImage<T>(image: Sharp, work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const abort = () => image.destroy();
  signal.addEventListener("abort", abort, { once: true });
  try {
    const result = await work();
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export function runMovieEncoder(args: string[], signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let timedOut = false;
    // Hard termination is intentional: this process only owns disposable output.
    const abort = () => { child.kill("SIGKILL"); };
    signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => { timedOut = true; abort(); }, 20 * 60_000);
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    };
    child.stderr.on("data", data => { stderr = (stderr + data.toString()).slice(-4000); });
    child.once("error", error => { cleanup(); reject(error); });
    // Do not resolve on abort: wait for process exit before deleting its files.
    child.once("close", code => {
      cleanup();
      if (signal.aborted) reject(signal.reason);
      else if (timedOut) reject(new Error("Movie rendering timed out"));
      else if (code === 0) resolve();
      else reject(new Error(`FFmpeg failed: ${stderr}`));
    });
  });
}
