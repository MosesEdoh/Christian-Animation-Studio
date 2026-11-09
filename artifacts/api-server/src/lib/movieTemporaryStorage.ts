import { lstat, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

// Shared with database job recovery; longer than the twenty-minute render budget.
export const MOVIE_RENDER_LEASE_MS = 30 * 60_000;
const prefix = "faith-movie-";
const ownerFile = ".render-owner.json";
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

export class MovieTemporaryStorage {
  private readonly active = new Set<string>();
  private recovery: Promise<number> | undefined;

  constructor(private readonly root = tmpdir()) {}

  async create(): Promise<string> {
    const directory = await mkdtemp(join(this.root, prefix));
    this.active.add(directory);
    try {
      // Atomic publication: a crash during the write leaves a legacy directory
      // recoverable after the lease, rather than a partially written owner file.
      await writeFile(join(directory, `${ownerFile}.pending`), JSON.stringify({
        pid: process.pid, host: hostname(),
      }), { flag: "wx" });
      await rename(join(directory, `${ownerFile}.pending`), join(directory, ownerFile));
      return directory;
    } catch (error) {
      await this.remove(directory);
      throw error;
    }
  }

  async remove(directory: string): Promise<void> {
    try { await rm(directory, { recursive: true, force: true }); }
    finally { this.active.delete(directory); }
  }

  recover(onError: (error: unknown, directory: string) => void, now = Date.now()): Promise<number> {
    // Do not accumulate overlapping scans when filesystem work is slow.
    if (this.recovery) return this.recovery;
    this.recovery = this.scan(onError, now).finally(() => { this.recovery = undefined; });
    return this.recovery;
  }

  private async scan(onError: (error: unknown, directory: string) => void, now: number): Promise<number> {
    let removed = 0;
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      // Exact mkdtemp names only. Never traverse symlinks or other temp stores.
      if (!/^faith-movie-[a-zA-Z0-9]{6}$/.test(entry.name) || !entry.isDirectory()) continue;
      const directory = join(this.root, entry.name);
      if (this.active.has(directory)) continue;
      try {
        const before = await lstat(directory);
        if (!before.isDirectory() || now - Math.max(before.mtimeMs, before.ctimeMs, before.birthtimeMs) <= MOVIE_RENDER_LEASE_MS) continue;
        try {
          const marker = join(directory, ownerFile);
          const markerStat = await lstat(marker);
          if (!markerStat.isFile() || markerStat.size > 1024) continue;
          const owner = JSON.parse(await readFile(marker, "utf8"));
          // Unknown ownership is not proof of abandonment. A live PID is
          // protected even past the lease (PID reuse conservatively retains it).
          if (owner?.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) continue;
          try {
            process.kill(owner.pid, 0);
            continue;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
          }
        } catch (error) {
          // Pre-upgrade / interrupted-creation directories have no marker.
          if (!missing(error)) throw error;
        }
        const current = await lstat(directory);
        if (this.active.has(directory) || !current.isDirectory() ||
          current.ino !== before.ino || current.dev !== before.dev ||
          current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs) continue;
        await rm(directory, { recursive: true, force: true });
        removed++;
      } catch (error) {
        // Another process or the render's finally block may have cleaned it.
        if (!missing(error)) onError(error, directory);
      }
    }
    return removed;
  }
}
