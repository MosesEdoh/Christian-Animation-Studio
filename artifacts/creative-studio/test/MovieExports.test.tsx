import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { StudioExport, StudioExportInput } from '@workspace/api-client-react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MovieExports } from '../src/components/MovieExports';
import { episode, otherEpisode } from './episodeFixtures';

const api = vi.hoisted(() => ({
  create: vi.fn<(variables: { data: StudioExportInput }) => Promise<StudioExport>>(),
  refetch: vi.fn(),
  jobs: [] as StudioExport[],
  listError: false,
}));

vi.mock('@workspace/api-client-react', async () => {
  const { useMutation } = await import('@tanstack/react-query');
  return {
    getListStudioExportsQueryKey: () => ['/api/studio/exports'],
    useListStudioExports: () => ({
      data: api.jobs, isError: api.listError, refetch: api.refetch,
    }),
    // Keep real mutation pending transitions, but never call an API or load media.
    useCreateStudioExport: () => useMutation({
      mutationFn: (variables: { data: StudioExportInput }) => api.create(variables),
    }),
    useCancelStudioExport: () => ({ mutateAsync: vi.fn() }),
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
  api.jobs = [];
  api.listError = false;
  api.create.mockReset().mockResolvedValue(job());
  api.refetch.mockReset();
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
      data: { episodeId: null, aspectRatio: '16:9', quality: '720p' },
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
      data: { episodeId: target === 'series' ? null : episode.id, aspectRatio, quality },
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
      { data: { episodeId, aspectRatio: '16:9', quality: '720p' } },
      { data: { episodeId, aspectRatio: '16:9', quality: '1080p' } },
      { data: { episodeId, aspectRatio: '9:16', quality: '720p' } },
      { data: { episodeId, aspectRatio: '9:16', quality: '1080p' } },
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
      data: { episodeId, aspectRatio: '9:16', quality: '1080p' },
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
