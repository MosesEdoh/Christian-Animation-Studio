import type { StudioExport } from '@workspace/api-client-react';
import { z } from 'zod';

const formatSchema = z.object({
  aspectRatio: z.enum(['16:9', '9:16']),
  quality: z.enum(['720p', '1080p']),
  requestId: z.string().uuid(),
});
const batchSchema = z.object({
  id: z.string().uuid(),
  episodeId: z.number().int().positive().nullable(),
  label: z.string(),
  queued: z.array(formatSchema).max(4),
  remaining: z.array(formatSchema).max(4),
}).refine(batch => {
  const formats = [...batch.queued, ...batch.remaining];
  return formats.length === 4
    && new Set(formats.map(format => `${format.aspectRatio}:${format.quality}`)).size === 4
    && new Set(formats.map(format => format.requestId)).size === 4;
});
const savedSchema = z.object({
  version: z.literal(1),
  accountId: z.string(),
  batches: z.record(z.string(), batchSchema),
});
export type MovieRequest = z.infer<typeof formatSchema>;
export type MovieFormat = Pick<MovieRequest, 'aspectRatio' | 'quality'>;
export type MovieBatch = z.infer<typeof batchSchema>;
export const movieBatchStorageKey = 'frame-faith:movie-batches:v1';
type SavedProgress = z.infer<typeof savedSchema>;

let saved: SavedProgress | undefined;
let generation = 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());
export const subscribeMovieBatches = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

// Called by the auth listener even when the movie panel is not mounted.
// A generation invalidates old async queue loops, including A -> B -> A.
export function activateMovieBatchAccount(accountId: string | null) {
  if (saved?.accountId === accountId) return;
  let restored: SavedProgress | undefined;
  try {
    const parsed = savedSchema.safeParse(JSON.parse(localStorage.getItem(movieBatchStorageKey) ?? 'null'));
    if (parsed.success && parsed.data.accountId === accountId && !saved) restored = parsed.data;
    else localStorage.removeItem(movieBatchStorageKey);
  } catch {
    // Invalid JSON should not survive forever; an unavailable store is reported
    // before starting a batch, where the creator can act on the error.
    try { localStorage.removeItem(movieBatchStorageKey); } catch { /* Storage blocked. */ }
  }
  saved = restored ?? { version: 1, accountId: accountId ?? '', batches: {} };
  generation++;
  notify();
}

export function movieBatchScope(accountId: string, projectId: number) {
  activateMovieBatchAccount(accountId);
  const epoch = generation;
  const key = String(projectId);
  const current = () => saved?.accountId === accountId && generation === epoch;
  return {
    current,
    get: () => current() ? saved?.batches[key] ?? null : null,
    save(batch: MovieBatch | null, expectedId?: string) {
      if (!current() || !saved) return;
      const previous = saved.batches[key];
      // Dismissing/replacing a batch must not let a late response resurrect it.
      if (expectedId && previous?.id !== expectedId) return;
      if (batch && previous?.id === batch.id) {
        const confirmed = new Set(previous.queued.map(format => format.requestId));
        batch = {
          ...batch,
          queued: [...batch.queued, ...batch.remaining.filter(format => confirmed.has(format.requestId))],
          remaining: batch.remaining.filter(format => !confirmed.has(format.requestId)),
        };
      }
      const batches = { ...saved.batches };
      if (batch) batches[key] = batch;
      else delete batches[key];
      const next = { ...saved, batches };
      try { localStorage.setItem(movieBatchStorageKey, JSON.stringify(next)); }
      catch { throw new Error('Could not save batch progress in this browser. Allow browser storage before queueing missing formats.'); }
      saved = next;
      notify();
    },
  };
}

// Match only this batch's exact request IDs. Older movies with the same format
// are not evidence that a new batch request was accepted. Failed/cancelled jobs
// still count as queued: rebuilding those is a separate explicit action.
export function reconcileMovieBatch(batch: MovieBatch, jobs: StudioExport[]): MovieBatch {
  const confirmed = batch.remaining.filter(format => jobs.some(job =>
    job.requestId === format.requestId && job.episodeId === batch.episodeId
      && job.aspectRatio === format.aspectRatio && job.quality === format.quality));
  if (!confirmed.length) return batch;
  return {
    ...batch,
    queued: [...batch.queued, ...confirmed],
    remaining: batch.remaining.filter(format => !confirmed.includes(format)),
  };
}
