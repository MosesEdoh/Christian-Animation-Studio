import { lstat, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { EPISODE_EXPORT_LEASE_MS, EPISODE_EXPORT_LIFETIME_MS } from "./episodeExportTiming";

// Also covers the longest possible pre-upgrade export and an outstanding renewal.
export const EPISODE_TEMPORARY_RETENTION_MS = EPISODE_EXPORT_LIFETIME_MS + EPISODE_EXPORT_LEASE_MS;
const markerName = ".episode-owner.json";
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
type Owner = {
  version: 1;
  owner: string;
  pid: number;
  host: string;
  deadline: number;
  mediaPid: number | "starting" | null;
};
const validPid = (pid: unknown): pid is number => Number.isSafeInteger(pid) && Number(pid) > 0;
const validOwner = (value: Owner): boolean => value?.version === 1 &&
  typeof value.owner === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.owner) &&
  validPid(value.pid) && typeof value.host === "string" &&
  Number.isSafeInteger(value.deadline) && value.deadline > 0 &&
  (value.mediaPid === null || value.mediaPid === "starting" || validPid(value.mediaPid));

function isProcessGone(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

export class EpisodeTemporaryStorage {
  private readonly active = new Map<string, Owner>();
  private recovery: Promise<number> | undefined;

  constructor(
    private readonly leaseIsActive: (owner: string) => Promise<boolean>,
    private readonly root = tmpdir(),
  ) {}

  async create(owner: string, deadline: number): Promise<string> {
    const directory = await mkdtemp(join(this.root, "frame-faith-episode-"));
    const metadata: Owner = {
      version: 1, owner, deadline, pid: process.pid, host: hostname(), mediaPid: null,
    };
    this.active.set(directory, metadata);
    try {
      await this.publish(directory, metadata);
      return directory;
    } catch (error) {
      await this.remove(directory);
      throw error;
    }
  }

  private async publish(directory: string, metadata: Owner): Promise<void> {
    await writeFile(join(directory, `${markerName}.pending`), JSON.stringify(metadata));
    await rename(join(directory, `${markerName}.pending`), join(directory, markerName));
  }

  async setMediaProcess(directory: string, mediaPid: Owner["mediaPid"]): Promise<void> {
    const owner = this.active.get(directory);
    if (!owner) throw new Error("Episode temporary directory is not owned by this process.");
    const next = { ...owner, mediaPid };
    await this.publish(directory, next);
    this.active.set(directory, next);
  }

  async remove(directory: string): Promise<void> {
    // Keep local protection until deletion actually succeeds.
    await rm(directory, { recursive: true, force: true });
    this.active.delete(directory);
  }

  recover(onError: (error: unknown, directory: string) => void, now = Date.now()): Promise<number> {
    if (this.recovery) return this.recovery;
    this.recovery = this.scan(onError, now).finally(() => { this.recovery = undefined; });
    return this.recovery;
  }

  private async scan(onError: (error: unknown, directory: string) => void, now: number): Promise<number> {
    let removed = 0;
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!/^frame-faith-episode-[a-zA-Z0-9]{6}$/.test(entry.name) || !entry.isDirectory()) continue;
      const directory = join(this.root, entry.name);
      if (this.active.has(directory)) continue;
      try {
        const before = await lstat(directory);
        if (!before.isDirectory() ||
          now - Math.max(before.mtimeMs, before.ctimeMs, before.birthtimeMs) <= EPISODE_TEMPORARY_RETENTION_MS) continue;
        let marker: Awaited<ReturnType<typeof lstat>> | undefined;
        try {
          marker = await lstat(join(directory, markerName));
          if (!marker.isFile() || marker.size > 2048) continue;
          const owner: Owner = JSON.parse(await readFile(join(directory, markerName), "utf8"));
          // Expired leases alone never authorize deleting a live encoder/download.
          // Unknown hosts, PID reuse, and inaccessible processes fail conservatively.
          if (!validOwner(owner) || owner.host !== hostname() ||
            now <= owner.deadline + EPISODE_EXPORT_LEASE_MS ||
            !isProcessGone(owner.pid) || owner.mediaPid === "starting" ||
            (owner.mediaPid !== null && !isProcessGone(owner.mediaPid))) continue;
          // A failed database probe must retain the folder, not guess at expiry.
          if (await this.leaseIsActive(owner.owner)) continue;
        } catch (error) {
          // Missing metadata is a legacy/interrupted-creation directory. The
          // full lifetime plus lease grace above protects its creation window.
          if (!missing(error) || marker) throw error;
        }
        const current = await lstat(directory);
        if (this.active.has(directory) || !current.isDirectory() ||
          current.ino !== before.ino || current.dev !== before.dev ||
          current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs) continue;
        if (marker) {
          const currentMarker = await lstat(join(directory, markerName));
          if (currentMarker.ino !== marker.ino || currentMarker.dev !== marker.dev ||
            currentMarker.mtimeMs !== marker.mtimeMs || currentMarker.ctimeMs !== marker.ctimeMs) continue;
        }
        await rm(directory, { recursive: true, force: true });
        removed++;
      } catch (error) {
        if (!missing(error)) onError(error, directory);
      }
    }
    return removed;
  }
}
