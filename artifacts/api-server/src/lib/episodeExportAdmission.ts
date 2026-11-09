import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createBoundedDatabase } from "@workspace/db";
import { logger } from "./logger";

export const MAX_CONCURRENT_EPISODE_EXPORTS = 2;
export const EPISODE_EXPORT_RETRY_SECONDS = 15;
const LEASE_MS = 60_000;
const RENEW_MS = 15_000;
// Stop work well before another instance can reuse an expired lease.
const SAFETY_MS = 10_000;

export class EpisodeVideoBusyError extends Error {
  constructor() {
    super(`Episode exports are busy. Try again in ${EPISODE_EXPORT_RETRY_SECONDS} seconds.`);
    this.name = "EpisodeVideoBusyError";
  }
}

export interface EpisodeExportLease {
  signal: AbortSignal;
  assertOwned(): void;
  release(): Promise<void>;
}

export interface EpisodeAdmissionStore {
  acquire(owner: string): Promise<boolean>;
  renew(owner: string): Promise<boolean>;
  release(owner: string): Promise<void>;
}

// Lazily create the bounded pool; unit tests supply an explicit store and never
// open database connections. Keep workspace imports static for bundle ordering.
let database: ReturnType<typeof createBoundedDatabase> | undefined;
function getDatabase() {
  return database ??= createBoundedDatabase();
}

export class PostgresEpisodeAdmissionStore implements EpisodeAdmissionStore {
  constructor(
    readonly poolName = "provider-clip-episode",
    readonly capacity = MAX_CONCURRENT_EPISODE_EXPORTS,
    readonly leaseMs = LEASE_MS,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || !Number.isSafeInteger(leaseMs) || leaseMs < 1) {
      throw new Error("Invalid episode export admission configuration.");
    }
  }

  async acquire(owner: string): Promise<boolean> {
    const db = await getDatabase();
    return db.transaction(async tx => {
      await tx.execute(sql`INSERT INTO episode_export_pools (name, capacity)
        VALUES (${this.poolName}, ${this.capacity}) ON CONFLICT DO NOTHING`);
      // Serialize admission across processes, not just within this Node instance.
      const config = await tx.execute<{ capacity: number }>(sql`
        SELECT capacity FROM episode_export_pools WHERE name = ${this.poolName} FOR UPDATE`);
      if (config.rows[0]?.capacity !== this.capacity) {
        throw new Error("Episode export capacity differs from the shared pool configuration.");
      }
      await tx.execute(sql`DELETE FROM episode_export_leases
        WHERE pool = ${this.poolName} AND expires_at <= clock_timestamp()`);
      const result = await tx.execute(sql`
        INSERT INTO episode_export_leases (owner, pool, expires_at)
        SELECT ${owner}::uuid, ${this.poolName},
          clock_timestamp() + ${this.leaseMs} * interval '1 millisecond'
        WHERE (SELECT count(*) FROM episode_export_leases WHERE pool = ${this.poolName}) < ${this.capacity}
        RETURNING owner`);
      return result.rows.length === 1;
    });
  }

  async renew(owner: string): Promise<boolean> {
    const db = await getDatabase();
    const result = await db.execute(sql`UPDATE episode_export_leases
      SET expires_at = clock_timestamp() + ${this.leaseMs} * interval '1 millisecond'
      WHERE owner = ${owner}::uuid AND pool = ${this.poolName} AND expires_at > clock_timestamp()
      RETURNING owner`);
    return result.rows.length === 1;
  }

  async release(owner: string): Promise<void> {
    const db = await getDatabase();
    await db.execute(sql`DELETE FROM episode_export_leases
      WHERE owner = ${owner}::uuid AND pool = ${this.poolName}`);
  }
}

export async function acquireEpisodeExportLease(
  store: EpisodeAdmissionStore,
  timing = { leaseMs: LEASE_MS, renewMs: RENEW_MS, safetyMs: SAFETY_MS },
): Promise<EpisodeExportLease> {
  const owner = randomUUID();
  const controller = new AbortController();
  let deadline = performance.now() + timing.leaseMs - timing.safetyMs;
  if (!await store.acquire(owner)) throw new EpisodeVideoBusyError();
  let stopped = false;
  let renewing: Promise<void> | undefined;
  let renewal: NodeJS.Timeout | undefined;
  let watchdog: NodeJS.Timeout | undefined;
  const lose = () => {
    controller.abort(new Error("Episode export ownership was lost. Please retry the download."));
    clearTimeout(renewal);
    clearTimeout(watchdog);
  };
  const assertOwned = () => {
    if (performance.now() >= deadline) lose();
    controller.signal.throwIfAborted();
  };
  const armWatchdog = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(lose, Math.max(0, deadline - performance.now()));
    watchdog.unref();
  };
  const schedule = () => {
    renewal = setTimeout(() => {
      renewing = (async () => {
        try {
          assertOwned();
          const started = performance.now();
          const owned = await store.renew(owner);
          if (stopped) return;
          // A late response cannot revive local ownership after the deadline.
          assertOwned();
          if (!owned) { lose(); return; }
          deadline = started + timing.leaseMs - timing.safetyMs;
          armWatchdog();
          schedule();
        } catch {
          if (!stopped) lose();
        }
      })();
    }, timing.renewMs);
    renewal.unref();
  };
  armWatchdog();
  schedule();
  let released: Promise<void> | undefined;
  const release = () => released ??= (async () => {
    stopped = true;
    clearTimeout(renewal);
    clearTimeout(watchdog);
    // Do not let an in-flight heartbeat race a completed release.
    await renewing;
    try {
      await store.release(owner);
    } catch {
      // Fail closed: the slot stays occupied until its database expiry.
      logger.warn("Episode export lease release failed; waiting for lease expiry");
    }
  })();
  try {
    assertOwned();
  } catch (error) {
    await release();
    throw error;
  }
  return { signal: controller.signal, assertOwned, release };
}

const sharedStore = new PostgresEpisodeAdmissionStore();
export const episodeExportAdmission = {
  acquire: () => acquireEpisodeExportLease(sharedStore),
};
