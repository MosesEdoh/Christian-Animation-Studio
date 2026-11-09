import { describe, expect, it, vi } from 'vitest';

const storageKey = 'frame-faith:movie-batches:v1';
const request = (aspectRatio: '16:9' | '9:16', quality: '720p' | '1080p') =>
  ({ aspectRatio, quality, requestId: crypto.randomUUID() });
const batch = () => ({
  id: crypto.randomUUID(), episodeId: 42, label: 'Episode 3',
  queued: [request('16:9', '720p')],
  remaining: [request('16:9', '1080p'), request('9:16', '720p'), request('9:16', '1080p')],
});

describe('Movie batch browser persistence', () => {
  it('rehydrates a partially queued batch in a fresh module after a full page reload', async () => {
    vi.resetModules();
    const first = await import('../src/lib/movieBatchProgress');
    const original = batch();
    first.movieBatchScope('creator', 1).save(original);
    vi.resetModules();
    const reloaded = await import('../src/lib/movieBatchProgress');
    expect(reloaded.movieBatchScope('creator', 1).get()).toEqual(original);
    expect(reloaded.movieBatchScope('creator', 2).get()).toBeNull();
  });

  it('does not rehydrate progress for a different account or after sign-out', async () => {
    vi.resetModules();
    const first = await import('../src/lib/movieBatchProgress');
    first.movieBatchScope('creator', 1).save(batch());
    vi.resetModules();
    const reloaded = await import('../src/lib/movieBatchProgress');
    expect(reloaded.movieBatchScope('someone-else', 1).get()).toBeNull();
    expect(localStorage.getItem(storageKey)).toBeNull();
    reloaded.movieBatchScope('someone-else', 1).save(batch());
    reloaded.activateMovieBatchAccount(null);
    expect(localStorage.getItem(storageKey)).toBeNull();
    expect(reloaded.movieBatchScope('someone-else', 1).get()).toBeNull();
  });

  it.each(['not json', '{"version":2}', JSON.stringify({
    version: 1, accountId: 'creator', batches: { '1': { ...batch(), remaining: [] } },
  })])('discards invalid saved progress safely: %s', async invalid => {
    localStorage.setItem(storageKey, invalid);
    vi.resetModules();
    const reloaded = await import('../src/lib/movieBatchProgress');
    expect(reloaded.movieBatchScope('creator', 1).get()).toBeNull();
    expect(localStorage.getItem(storageKey)).toBeNull();
  });

  it('merges late acknowledgements without losing newer confirmed progress', async () => {
    vi.resetModules();
    const store = await import('../src/lib/movieBatchProgress');
    const scope = store.movieBatchScope('creator', 1);
    const original = batch();
    scope.save(original);
    const next = {
      ...original,
      queued: [...original.queued, original.remaining[0]],
      remaining: original.remaining.slice(1),
    };
    scope.save(next, original.id);
    scope.save(original, original.id);
    expect(scope.get()).toEqual(next);
    scope.save(null, original.id);
    scope.save(next, original.id);
    expect(scope.get()).toBeNull();
  });
});
