import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { StudioExport, StudioExportInput } from '@workspace/api-client-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MovieExports } from '../src/components/MovieExports';
import { episode, otherEpisode } from './episodeFixtures';

const api = vi.hoisted(() => ({
  create: vi.fn<(variables: { data: StudioExportInput }) => Promise<StudioExport>>(),
  refetch: vi.fn(),
  jobs: [] as StudioExport[],
  listError: false,
  preflight: vi.fn(),
  estimate: { canQueue: true, message: 'Entire series fits the card and playback limits for the saved scripts.', cards: 12, playbackSeconds: 90, cardLimit: 2000, playbackLimitSeconds: 21600 },
  checking: false,
  estimateError: false,
}));

vi.mock('../src/hooks/useMovieExportHistory', async importOriginal => ({
  ...await importOriginal<object>(),
  useMovieExportHistory: () => ({
    jobs: api.jobs, isError: api.listError, refetch: api.refetch,
  }),
}));

vi.mock('@workspace/api-client-react', async () => {
  const { useMutation } = await import('@tanstack/react-query');
  return {
    preflightStudioExport: api.preflight,
    getPreflightStudioExportQueryKey: (params: unknown) => ['/api/studio/exports/preflight', params],
    usePreflightStudioExport: () => ({ data: api.estimate, isPending: api.checking, isError: api.estimateError, refetch: api.refetch }),
    getListStudioExportsQueryKey: () => ['/api/studio/exports'],
    useListStudioExports: () => ({
      data: api.jobs, isError: api.listError, refetch: api.refetch,
    }),
    // Keep real mutation pending transitions, but never call an API or load media.
    useCreateStudioExport: () => useMutation({
      mutationFn: (variables: { data: StudioExportInput }) => api.create(variables),
    }),
    useCancelStudioExport: () => ({ mutateAsync: vi.fn() }),
    useDeleteStudioExport: () => ({ mutateAsync: vi.fn() }),
  };
});

function job(overrides: Partial<StudioExport> = {}): StudioExport {
  return {
    id: 11, episodeId: null, aspectRatio: '16:9', quality: '720p',
    status: 'queued', progress: 0, url: null, error: null,
    createdAt: '2026-11-09T12:00:00Z', ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function mount() {
  const cache = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
  });
  const invalidate = vi.spyOn(cache, 'invalidateQueries');
  const view = render(
    <QueryClientProvider client={cache}>
      <MovieExports episodes={[otherEpisode, episode]} />
    </QueryClientProvider>,
  );
  return {
    ...view,
    invalidate,
    refresh: () => view.rerender(
      <QueryClientProvider client={cache}>
        <MovieExports episodes={[otherEpisode, episode]} />
      </QueryClientProvider>,
    ),
  };
}

const build = () => screen.getByRole('button', { name: 'Build storyboard MP4' });
const buildAll = () => screen.getByRole('button', { name: 'Build all four formats' });
const select = (name: string, value: string) =>
  fireEvent.change(screen.getByRole('combobox', { name }), { target: { value } });
const expectRefresh = async (invalidate: ReturnType<typeof mount>['invalidate']) => {
  await waitFor(() => expect(invalidate).toHaveBeenCalledExactlyOnceWith({
    queryKey: ['/api/studio/exports'],
  }));
};

beforeEach(() => {
  delete window.umami;
  api.jobs = [];
  api.listError = false;
  api.create.mockReset().mockResolvedValue(job());
  api.refetch.mockReset();
  api.estimate = { canQueue: true, message: 'Entire series fits the card and playback limits for the saved scripts.', cards: 12, playbackSeconds: 90, cardLimit: 2000, playbackLimitSeconds: 21600 };
  api.preflight.mockReset().mockImplementation(async () => api.estimate);
  api.checking = api.estimateError = false;
});

afterEach(() => {
  delete window.umami;
});

describe('MovieExports privacy-safe analytics', () => {
  function tracker() {
    const track = vi.fn();
    window.umami = { track };
    return track;
  }

  it.each(['passed', 'blocked', 'unavailable'] as const)('records %s estimates once, without private content', outcome => {
    const track = tracker();
    api.estimate.canQueue = outcome !== 'blocked';
    api.estimateError = outcome === 'unavailable';
    api.estimate.message = 'PRIVATE script title /reference/path user@example.com';
    const view = mount();
    view.refresh();
    select('Resolution', '1080p');
    expect(track.mock.calls).toEqual([['movie_preflight_outcome', {
      source: 'estimate', target: 'series', aspect_ratio: '16:9', outcome,
    }]]);
  });

  it('does not record loading as an outcome, but records outcome and orientation changes', () => {
    const track = tracker();
    api.checking = true;
    const view = mount();
    expect(track).not.toHaveBeenCalled();
    api.checking = false;
    view.refresh();
    api.estimate = { ...api.estimate, canQueue: false };
    view.refresh();
    select('Orientation', '9:16');
    expect(track.mock.calls.map(([, data]) => data)).toEqual([
      { source: 'estimate', target: 'series', aspect_ratio: '16:9', outcome: 'passed' },
      { source: 'estimate', target: 'series', aspect_ratio: '16:9', outcome: 'blocked' },
      { source: 'estimate', target: 'series', aspect_ratio: '9:16', outcome: 'blocked' },
    ]);
  });

  it.each(['blocked', 'unavailable', 'passed', 'unchecked'] as const)('attributes episode selection and queue success after %s series preflight', async outcome => {
    const track = tracker();
    api.estimate.canQueue = outcome !== 'blocked';
    api.estimateError = outcome === 'unavailable';
    api.checking = outcome === 'unchecked';
    const { refresh, invalidate } = mount();
    select('Episode or series', String(episode.id));
    api.estimate = { ...api.estimate, canQueue: true };
    api.estimateError = api.checking = false;
    refresh();
    // Choosing another episode is not another series-to-episode switch.
    select('Episode or series', String(otherEpisode.id));
    fireEvent.click(build());
    await expectRefresh(invalidate);
    expect(track.mock.calls.filter(([name]) => name === 'movie_episode_selected')).toEqual([
      ['movie_episode_selected', { preceding_series_preflight: outcome }],
    ]);
    expect(track.mock.calls.filter(([name]) => name === 'movie_queue_succeeded')).toEqual([
      ['movie_queue_succeeded', {
        target: 'episode', aspect_ratio: '16:9', quality: '720p',
        request_mode: 'single', preceding_series_preflight: outcome,
      }],
    ]);
  });

  it.each(['blocked', 'unavailable'] as const)('records fresh queue preflight %s separately from a passing displayed estimate', async outcome => {
    const track = tracker();
    if (outcome === 'blocked') api.preflight.mockResolvedValueOnce({ ...api.estimate, canQueue: false });
    else api.preflight.mockRejectedValueOnce(new Error('PRIVATE response detail'));
    mount();
    fireEvent.click(build());
    await waitFor(() => expect(build()).toBeEnabled());
    expect(track).toHaveBeenCalledWith('movie_preflight_outcome', {
      source: 'queue', target: 'series', aspect_ratio: '16:9',
      outcome, request_mode: 'single',
    });
    select('Episode or series', String(episode.id));
    expect(track).toHaveBeenCalledWith('movie_episode_selected', { preceding_series_preflight: outcome });
    expect(track.mock.calls.some(([name]) => name === 'movie_queue_succeeded')).toBe(false);
    expect(api.create).not.toHaveBeenCalled();
  });

  it('counts only confirmed requests in a partial batch and its missing-format retry', async () => {
    const track = tracker();
    api.create.mockResolvedValueOnce(job()).mockRejectedValueOnce(new Error('PRIVATE queue error'));
    const { invalidate } = mount();
    fireEvent.click(buildAll());
    await expectRefresh(invalidate);
    const successes = () => track.mock.calls.filter(([name]) => name === 'movie_queue_succeeded');
    expect(successes()).toEqual([['movie_queue_succeeded', {
      target: 'series', aspect_ratio: '16:9', quality: '720p',
      request_mode: 'all_formats', preceding_series_preflight: 'passed',
    }]]);
    fireEvent.click(screen.getByRole('button', { name: 'Queue missing formats' }));
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2));
    expect(successes()).toHaveLength(4);
    expect(successes().slice(1).map(([, data]) => [data.aspect_ratio, data.quality, data.request_mode])).toEqual([
      ['16:9', '1080p', 'missing_formats'],
      ['9:16', '720p', 'missing_formats'],
      ['9:16', '1080p', 'missing_formats'],
    ]);
    expect(JSON.stringify(track.mock.calls)).not.toContain('PRIVATE');
  });

  it('records a saved-job retry using its actual target and format, not the form', async () => {
    const track = tracker();
    api.jobs = [job({ status: 'failed', episodeId: episode.id, aspectRatio: '9:16', quality: '1080p' })];
    const { invalidate } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Build again' }));
    await expectRefresh(invalidate);
    expect(track).toHaveBeenCalledWith('movie_queue_succeeded', {
      target: 'episode', aspect_ratio: '9:16', quality: '1080p',
      request_mode: 'retry', preceding_series_preflight: 'passed',
    });
  });

  it.each(['missing', 'throws', 'rejects'] as const)('keeps exports working when the tracker %s', async failure => {
    if (failure !== 'missing') window.umami = { track: () => {
      if (failure === 'throws') throw new Error('Tracker failed');
      return Promise.reject(new Error('Tracker failed asynchronously'));
    } };
    const { invalidate } = mount();
    select('Episode or series', String(episode.id));
    fireEvent.click(buildAll());
    await expectRefresh(invalidate);
    expect(api.create).toHaveBeenCalledTimes(4);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(build()).toBeEnabled();
  });
});

describe('MovieExports preflight', () => {
  it('shows the saved-script estimate and explains remaining render checks', () => {
    mount();
    expect(screen.getByTestId('movie-preflight')).toHaveTextContent('12 / 2,000 cards');
    expect(screen.getByTestId('movie-preflight')).toHaveTextContent('never automatically split or shortened');
    expect(screen.getByTestId('movie-preflight')).toHaveTextContent('does not guarantee a finished export');
  });

  it.each(['checking', 'estimateError', 'blocked'])('does not queue while preflight is %s', state => {
    if (state === 'checking') api.checking = true;
    else if (state === 'estimateError') api.estimateError = true;
    else api.estimate = { ...api.estimate, canQueue: false, message: 'Entire series exceeds the 2000 storyboard card limit. Choose an episode and export episodes separately.' };
    mount();
    expect(build()).toBeDisabled();
    expect(buildAll()).toBeDisabled();
    if (state === 'blocked') expect(screen.getByTestId('movie-preflight')).toHaveTextContent('export episodes separately');
    fireEvent.click(build());
    expect(api.create).not.toHaveBeenCalled();
  });

  it('checks both orientations before queueing any format and blocks the whole batch', async () => {
    api.preflight.mockResolvedValueOnce(api.estimate).mockResolvedValueOnce({
      ...api.estimate, canQueue: false, message: 'Portrait exceeds the 6 hour playback limit.',
    });
    mount();
    select('Episode or series', String(episode.id));
    fireEvent.click(buildAll());
    expect(await screen.findByRole('alert')).toHaveTextContent('6 hour playback limit');
    expect(api.preflight.mock.calls).toEqual([
      [{ episodeId: episode.id, aspectRatio: '16:9' }],
      [{ episodeId: episode.id, aspectRatio: '9:16' }],
    ]);
    expect(api.create).not.toHaveBeenCalled();
  });

  it('rechecks the retry target rather than using the current form estimate', async () => {
    api.jobs = [job({ status: 'failed', episodeId: episode.id, aspectRatio: '9:16' })];
    api.preflight.mockResolvedValueOnce({ ...api.estimate, canQueue: false, message: 'This episode exceeds the card limit.' });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Build again' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This episode exceeds');
    expect(api.preflight).toHaveBeenCalledExactlyOnceWith({ episodeId: episode.id, aspectRatio: '9:16' });
    expect(api.create).not.toHaveBeenCalled();
  });

  it('fails closed if the fresh estimate is unavailable', async () => {
    api.preflight.mockRejectedValueOnce(new Error('Could not check movie limits.'));
    mount();
    fireEvent.click(build());
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not check movie limits.');
    expect(api.create).not.toHaveBeenCalled();
    await waitFor(() => expect(build()).toBeEnabled());
  });
});

describe('MovieExports queue controls', () => {
  it('defaults to an entire-series landscape 720p movie', async () => {
    const { invalidate } = mount();
    expect(screen.getByRole('combobox', { name: 'Episode or series' })).toHaveValue('series');
    expect(screen.getByRole('combobox', { name: 'Orientation' })).toHaveValue('16:9');
    expect(screen.getByRole('combobox', { name: 'Resolution' })).toHaveValue('720p');
    fireEvent.click(build());
    await expectRefresh(invalidate);
    expect(api.create).toHaveBeenCalledExactlyOnceWith({
      data: { episodeId: null, aspectRatio: '16:9', quality: '720p', requestId: expect.any(String) },
    });
  });

  const selections = (['series', String(episode.id)] as const).flatMap(target =>
    (['16:9', '9:16'] as const).flatMap(aspectRatio =>
      (['720p', '1080p'] as const).map(quality => ({
        target, aspectRatio, quality,
      }))));

  it.each(selections)('queues $target / $aspectRatio / $quality with exact API values', async ({
    target, aspectRatio, quality,
  }) => {
    const { invalidate } = mount();
    // Episode numbers and option positions differ from the IDs the API needs.
    expect(screen.getByRole('option', { name: `Episode ${episode.number}: ${episode.title}` }))
      .toHaveValue(String(episode.id));
    select('Episode or series', target);
    select('Orientation', aspectRatio);
    select('Resolution', quality);
    fireEvent.click(build());
    await expectRefresh(invalidate);
    expect(api.create).toHaveBeenCalledExactlyOnceWith({
      data: { episodeId: target === 'series' ? null : episode.id, aspectRatio, quality, requestId: expect.any(String) },
    });
  });

  it.each(['series', String(otherEpisode.id)])('queues exactly four unique formats for %s', async target => {
    const { invalidate } = mount();
    select('Episode or series', target);
    select('Orientation', '9:16');
    select('Resolution', '1080p');
    fireEvent.click(buildAll());
    await expectRefresh(invalidate);
    const episodeId = target === 'series' ? null : otherEpisode.id;
    expect(api.create.mock.calls.map(([request]) => request)).toEqual([
      { data: { episodeId, aspectRatio: '16:9', quality: '720p', requestId: expect.any(String) } },
      { data: { episodeId, aspectRatio: '16:9', quality: '1080p', requestId: expect.any(String) } },
      { data: { episodeId, aspectRatio: '9:16', quality: '720p', requestId: expect.any(String) } },
      { data: { episodeId, aspectRatio: '9:16', quality: '1080p', requestId: expect.any(String) } },
    ]);
  });

  it.each(['success', 'failure'])('disables build and retry buttons while queueing, then unlocks on %s', async outcome => {
    api.jobs = [job({ status: 'failed', error: 'Previous render failed.' })];
    const pending = deferred<StudioExport>();
    api.create.mockReturnValueOnce(pending.promise);
    mount();
    const retry = screen.getByRole('button', { name: 'Build again' });
    fireEvent.click(build());
    await waitFor(() => expect(build()).toBeDisabled());
    expect(buildAll()).toBeDisabled();
    expect(retry).toBeDisabled();
    fireEvent.click(build());
    fireEvent.click(buildAll());
    fireEvent.click(retry);
    expect(api.create).toHaveBeenCalledTimes(1);
    await act(async () => {
      if (outcome === 'success') pending.resolve(job());
      else pending.reject(new Error('Queue unavailable.'));
    });
    await waitFor(() => expect(build()).toBeEnabled());
    expect(buildAll()).toBeEnabled();
    expect(retry).toBeEnabled();
    if (outcome === 'failure') expect(screen.getByRole('alert')).toHaveTextContent('Queue unavailable.');
  });

  it('keeps both build buttons disabled through each of the four requests', async () => {
    const requests = Array.from({ length: 4 }, () => deferred<StudioExport>());
    requests.forEach(request => api.create.mockReturnValueOnce(request.promise));
    const { invalidate } = mount();
    fireEvent.click(buildAll());
    for (let index = 0; index < requests.length; index++) {
      await waitFor(() => expect(api.create).toHaveBeenCalledTimes(index + 1));
      await waitFor(() => expect(buildAll()).toBeDisabled());
      expect(build()).toBeDisabled();
      expect(invalidate).not.toHaveBeenCalled();
      await act(async () => requests[index].resolve(job({ id: index + 1 })));
    }
    await expectRefresh(invalidate);
    await waitFor(() => expect(buildAll()).toBeEnabled());
    expect(build()).toBeEnabled();
  });
});

describe('MovieExports errors and retries', () => {
  it('keeps each missing format request ID after a lost response and uses fresh IDs for a new batch', async () => {
    api.create.mockResolvedValueOnce(job()).mockRejectedValueOnce(new Error('Connection dropped after acceptance.'));
    const { invalidate } = mount();
    fireEvent.click(buildAll());
    await expectRefresh(invalidate);
    const firstRequest = api.create.mock.calls[0][0].data;
    const uncertainRequest = api.create.mock.calls[1][0].data;
    expect(firstRequest.requestId).toBeTruthy();
    expect(uncertainRequest.requestId).not.toBe(firstRequest.requestId);
    fireEvent.click(screen.getByRole('button', { name: 'Queue missing formats' }));
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2));
    expect(api.create.mock.calls[2][0].data).toEqual(uncertainRequest);
    const confirmedIds = [0, 2, 3, 4].map(i => api.create.mock.calls[i][0].data.requestId);
    expect(new Set(confirmedIds).size).toBe(4);
    await waitFor(() => expect(buildAll()).toBeEnabled());
    fireEvent.click(buildAll());
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(3));
    const newIds = api.create.mock.calls.slice(5).map(([request]) => request.data.requestId);
    expect(new Set(newIds).size).toBe(4);
    expect(newIds.every(id => !confirmedIds.includes(id))).toBe(true);
  });

  it('reuses an unconfirmed single request after selection changes, then creates a fresh intent after success', async () => {
    api.create.mockRejectedValueOnce(new Error('Response lost.'));
    const { invalidate } = mount();
    fireEvent.click(build());
    await screen.findByRole('alert');
    await waitFor(() => expect(build()).toBeEnabled());
    const uncertain = api.create.mock.calls[0][0].data;
    select('Orientation', '9:16');
    fireEvent.click(build());
    await expectRefresh(invalidate);
    expect(api.create.mock.calls[1][0].data.requestId).not.toBe(uncertain.requestId);
    await waitFor(() => expect(build()).toBeEnabled());
    select('Orientation', '16:9');
    fireEvent.click(build());
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2));
    expect(api.create.mock.calls[2][0].data).toEqual(uncertain);
    await waitFor(() => expect(build()).toBeEnabled());
    fireEvent.click(build());
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(3));
    expect(api.create.mock.calls[3][0].data.requestId).not.toBe(uncertain.requestId);
  });

  it('retries an unconfirmed Build again with its key, but uses a new key after acknowledgement', async () => {
    api.jobs = [job({ status: 'failed' })];
    api.create.mockRejectedValueOnce(new Error('Response lost.'));
    const { invalidate } = mount();
    const retry = screen.getByRole('button', { name: 'Build again' });
    fireEvent.click(retry);
    await screen.findByRole('alert');
    await waitFor(() => expect(retry).toBeEnabled());
    fireEvent.click(retry);
    await expectRefresh(invalidate);
    expect(api.create.mock.calls[1][0]).toEqual(api.create.mock.calls[0][0]);
    await waitFor(() => expect(retry).toBeEnabled());
    fireEvent.click(retry);
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2));
    expect(api.create.mock.calls[2][0].data.requestId).not.toBe(api.create.mock.calls[0][0].data.requestId);
  });

  it('reports partial success, refreshes the list, and resumes only missing formats for the original target', async () => {
    api.create.mockResolvedValueOnce(job()).mockRejectedValueOnce(new Error('Queue is full.'));
    const { invalidate } = mount();
    select('Episode or series', String(episode.id));
    fireEvent.click(buildAll());
    expect(await screen.findByRole('alert')).toHaveTextContent('Queue is full.');
    await expectRefresh(invalidate);
    expect(api.create).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('movie-batch-summary')).toHaveTextContent(`Episode ${episode.number}`);
    expect(screen.getByTestId('movie-batch-queued')).toHaveTextContent('Queued successfully: 16:9 · 720p.');
    expect(screen.getByTestId('movie-batch-missing')).toHaveTextContent('16:9 · 1080p, 9:16 · 720p, 9:16 · 1080p');
    expect(buildAll()).toBeDisabled();
    // Changing the form must not change the batch's retry target or formats.
    select('Episode or series', String(otherEpisode.id));
    select('Orientation', '9:16');
    select('Resolution', '1080p');
    api.preflight.mockClear();
    const pending = deferred<StudioExport>();
    api.create.mockReturnValueOnce(pending.promise);
    const resume = screen.getByRole('button', { name: 'Queue missing formats' });
    fireEvent.click(resume);
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(3));
    expect(resume).toBeDisabled();
    fireEvent.click(resume);
    expect(api.create).toHaveBeenCalledTimes(3);
    await act(async () => pending.resolve(job()));
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2));
    expect(api.preflight.mock.calls).toEqual([
      [{ episodeId: episode.id, aspectRatio: '16:9' }],
      [{ episodeId: episode.id, aspectRatio: '9:16' }],
    ]);
    expect(api.create.mock.calls.slice(2).map(([request]) => request)).toEqual([
      { data: { episodeId: episode.id, aspectRatio: '16:9', quality: '1080p', requestId: expect.any(String) } },
      { data: { episodeId: episode.id, aspectRatio: '9:16', quality: '720p', requestId: expect.any(String) } },
      { data: { episodeId: episode.id, aspectRatio: '9:16', quality: '1080p', requestId: expect.any(String) } },
    ]);
    expect(screen.getByTestId('movie-batch-queued')).toHaveTextContent('16:9 · 720p, 16:9 · 1080p, 9:16 · 720p, 9:16 · 1080p');
    expect(screen.getByTestId('movie-batch-missing')).toHaveTextContent('None — all four formats are queued');
    expect(screen.queryByRole('button', { name: 'Queue missing formats' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('preserves progress through another failure and retries only the still-missing formats', async () => {
    api.create.mockResolvedValueOnce(job()).mockRejectedValueOnce(new Error('Queue is full.'));
    const { invalidate } = mount();
    fireEvent.click(buildAll());
    await expectRefresh(invalidate);
    api.create.mockResolvedValueOnce(job()).mockRejectedValueOnce(new Error('Queue is still full.'));
    fireEvent.click(screen.getByRole('button', { name: 'Queue missing formats' }));
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('alert')).toHaveTextContent('Queue is still full.');
    expect(screen.getByTestId('movie-batch-queued')).toHaveTextContent('16:9 · 720p, 16:9 · 1080p');
    expect(screen.getByTestId('movie-batch-missing')).toHaveTextContent('Not queued: 9:16 · 720p, 9:16 · 1080p.');
    fireEvent.click(screen.getByRole('button', { name: 'Queue missing formats' }));
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(3));
    expect(api.create.mock.calls.slice(4).map(([request]) => request.data)).toEqual([
      { episodeId: null, aspectRatio: '9:16', quality: '720p', requestId: expect.any(String) },
      { episodeId: null, aspectRatio: '9:16', quality: '1080p', requestId: expect.any(String) },
    ]);
  });

  it('keeps the missing formats available if fresh preflight blocks the retry', async () => {
    api.create.mockResolvedValueOnce(job()).mockRejectedValueOnce(new Error('Queue is full.'));
    const { invalidate } = mount();
    fireEvent.click(buildAll());
    await expectRefresh(invalidate);
    api.preflight.mockResolvedValueOnce({ ...api.estimate, canQueue: false, message: 'Saved scripts exceed movie limits.' });
    fireEvent.click(screen.getByRole('button', { name: 'Queue missing formats' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Saved scripts exceed movie limits.'));
    expect(api.create).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('movie-batch-queued')).toHaveTextContent('Queued successfully: 16:9 · 720p.');
    expect(screen.getByRole('button', { name: 'Queue missing formats' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss batch summary' }));
    expect(screen.queryByTestId('movie-batch-summary')).not.toBeInTheDocument();
    expect(buildAll()).toBeEnabled();
  });

  it.each([
    { cause: new Error('Movie storage is full.'), message: 'Movie storage is full.' },
    { cause: 'unexpected response', message: 'Could not queue movie.' },
  ])('shows creation errors and clears them on a successful retry: $message', async ({ cause, message }) => {
    api.create.mockRejectedValueOnce(cause);
    const { invalidate } = mount();
    fireEvent.click(build());
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(invalidate).not.toHaveBeenCalled();
    await waitFor(() => expect(build()).toBeEnabled());
    fireEvent.click(build());
    await expectRefresh(invalidate);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(api.create).toHaveBeenCalledTimes(2);
  });

  it('shows list errors, refetches on Retry, and clears the error after recovery', () => {
    api.listError = true;
    const { refresh } = mount();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Could not load movie exports.');
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(api.refetch).toHaveBeenCalledExactlyOnceWith();
    expect(api.create).not.toHaveBeenCalled();
    api.listError = false;
    refresh();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([null, episode.id])('retries the failed job format and target %s, not the current form', async episodeId => {
    api.jobs = [job({
      episodeId, status: 'failed', aspectRatio: '9:16', quality: '1080p',
      error: 'Renderer could not finish.',
    })];
    const { invalidate } = mount();
    select('Episode or series', String(otherEpisode.id));
    select('Orientation', '16:9');
    select('Resolution', '720p');
    expect(screen.getByTestId('movie-job-11')).toHaveTextContent('Renderer could not finish.');
    fireEvent.click(screen.getByRole('button', { name: 'Build again' }));
    await expectRefresh(invalidate);
    expect(api.create).toHaveBeenCalledExactlyOnceWith({
      data: { episodeId, aspectRatio: '9:16', quality: '1080p', requestId: expect.any(String) },
    });
  });
});

describe('MovieExports saved preview and download', () => {
  const unavailable = () => [
    // A URL alone must not make an unfinished or failed job selectable.
    ...(['queued', 'rendering', 'failed'] as const).map((status, index) =>
      job({ id: index + 1, status, url: `/fixtures/not-ready-${index}.mp4` })),
    job({ id: 4, status: 'ready', url: null }),
    job({ id: 5, status: 'ready', url: '' }),
  ];
  const readyJobs = () => [
    job({ id: 21, status: 'ready', url: '/fixtures/series.mp4' }),
    job({
      id: 22, episodeId: episode.id, status: 'ready',
      aspectRatio: '9:16', quality: '1080p', url: '/fixtures/episode.mp4',
    }),
  ];

  it('hides preview and download when no ready job has a usable URL', () => {
    api.jobs = unavailable();
    mount();
    expect(screen.queryByRole('combobox', { name: 'Saved movie preview' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('movie-preview')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Download MP4' })).not.toBeInTheDocument();
  });

  it('offers only ready movies with URLs and updates the player and download together', () => {
    api.jobs = [...unavailable(), ...readyJobs()];
    const { refresh } = mount();
    const picker = screen.getByRole('combobox', { name: 'Saved movie preview' });
    const options = within(picker).getAllByRole('option');
    expect(options.map(option => option.getAttribute('value'))).toEqual(['21', '22']);
    expect(options[0]).toHaveTextContent('Entire series · 16:9 · 720p');
    expect(options[1]).toHaveTextContent(`Episode ${episode.number} · 9:16 · 1080p`);
    expect(picker).toHaveValue('21');
    expect(screen.getByTestId('movie-preview')).toHaveAttribute('src', '/fixtures/series.mp4');
    expect(screen.getByRole('link', { name: 'Download MP4' })).toHaveAttribute('href', '/fixtures/series.mp4');
    expect(screen.getByRole('link', { name: 'Download MP4' })).toHaveAttribute('download', 'storyboard-21-720p.mp4');

    select('Saved movie preview', '22');
    expect(picker).toHaveValue('22');
    expect(screen.getByTestId('movie-preview')).toHaveAttribute('src', '/fixtures/episode.mp4');
    expect(screen.getByRole('link', { name: 'Download MP4' })).toHaveAttribute('href', '/fixtures/episode.mp4');
    expect(screen.getByRole('link', { name: 'Download MP4' })).toHaveAttribute('download', 'storyboard-22-1080p.mp4');

    // A polling refresh must preserve a still-valid selection.
    api.jobs = [...readyJobs()].reverse();
    refresh();
    expect(screen.getByRole('combobox', { name: 'Saved movie preview' })).toHaveValue('22');
    // If the selected movie becomes unavailable, fall back to another ready movie.
    api.jobs = [readyJobs()[0], job({ id: 22, status: 'failed', url: '/fixtures/stale.mp4' })];
    refresh();
    expect(screen.getByRole('combobox', { name: 'Saved movie preview' })).toHaveValue('21');
    expect(screen.getByTestId('movie-preview')).toHaveAttribute('src', '/fixtures/series.mp4');
    expect(screen.getByRole('link', { name: 'Download MP4' })).toHaveAttribute('href', '/fixtures/series.mp4');
    api.jobs = [];
    refresh();
    expect(screen.queryByTestId('movie-preview')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Download MP4' })).not.toBeInTheDocument();
  });
});
