import { addAbortSignal } from "node:stream";
import type { Readable } from "node:stream";

const MiB = 1024 * 1024;
export const movieLimits = Object.freeze({
  frames: 2000,
  referenceBytes: 8 * MiB,
  totalReferenceBytes: 64 * MiB,
  temporaryBytes: 512 * MiB,
  renderMs: 20 * 60_000,
  playbackSeconds: 6 * 60 * 60,
});

// Only these deliberately authored errors may be shown to a creator.
export class MovieBudgetError extends Error {}
export const smallerMovie = "Export one episode at a time, or shorten the script and try again.";

export class MovieBudget {
  private references = 0;
  private temporary = 0;
  readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout>;
  private readonly abort: () => void;
  private readonly deadline: number;
  readonly expiresAt: Date;

  constructor(
    parent: AbortSignal,
    readonly limits = movieLimits,
  ) {
    this.deadline = performance.now() + limits.renderMs;
    this.expiresAt = new Date(Date.now() + limits.renderMs);
    this.abort = () => this.controller.abort(parent.reason);
    parent.addEventListener("abort", this.abort, { once: true });
    if (parent.aborted) this.abort();
    this.timer = setTimeout(() => this.controller.abort(new MovieBudgetError(
      `Movie exceeded the ${Math.ceil(limits.renderMs / 60_000)} minute render limit. ${smallerMovie}`,
    )), limits.renderMs);
    this.dispose = () => {
      clearTimeout(this.timer);
      parent.removeEventListener("abort", this.abort);
    };
  }

  dispose: () => void;
  get signal() { return this.controller.signal; }
  get remainingSeconds() { return Math.max(1, Math.ceil((this.deadline - performance.now()) / 1000)); }
  checkFrames(count: number) {
    this.signal.throwIfAborted();
    if (count > this.limits.frames) throw new MovieBudgetError(
      `Movie exceeds the ${this.limits.frames} storyboard card limit. ${smallerMovie}`,
    );
  }
  checkDuration(seconds: number) {
    this.signal.throwIfAborted();
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > this.limits.playbackSeconds) {
      throw new MovieBudgetError(`Movie has an invalid duration or exceeds the 6 hour playback limit. ${smallerMovie}`);
    }
  }
  get remainingTemporaryBytes() { return this.limits.temporaryBytes - this.temporary; }
  addTemporary(bytes: number) {
    this.signal.throwIfAborted();
    if (bytes > this.remainingTemporaryBytes) throw this.diskError();
    this.temporary += bytes;
  }
  diskError() {
    return new MovieBudgetError(`Movie exceeds the ${Math.floor(this.limits.temporaryBytes / MiB)} MB temporary storage limit. Choose 720p, use smaller reference images, or export one episode at a time.`);
  }
  async reference(stream: Readable): Promise<Buffer> {
    let bytes = 0;
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of addAbortSignal(this.signal, stream)) {
        this.signal.throwIfAborted();
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        this.references += buffer.length;
        if (bytes > this.limits.referenceBytes || this.references > this.limits.totalReferenceBytes) {
          throw new MovieBudgetError("Movie reference images exceed the download budget (8 MB per image, 64 MB per movie). Upload smaller reference images or export one episode at a time.");
        }
        chunks.push(buffer);
      }
      this.signal.throwIfAborted();
      return Buffer.concat(chunks, bytes);
    } finally {
      stream.destroy();
    }
  }
}

// Read-only lookups may finish late, but must not hold the worker after timeout.
export async function movieLookup<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { signal.removeEventListener("abort", abort); }
}

// Status reporting/cleanup needs its own short deadline, even after the render
// signal is aborted. The database also enforces a server-side statement timeout.
export async function movieOperation<T>(work: PromiseLike<T>, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new MovieBudgetError(
    "Movie status or cleanup timed out. Try building the movie again.",
  )), 5000);
  try {
    return await movieLookup(work, parent ? AbortSignal.any([parent, controller.signal]) : controller.signal);
  } finally { clearTimeout(timer); }
}
