import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  getListStudioExportsQueryKey,
  type StudioExport,
  type StudioExportPreflight,
} from '@workspace/api-client-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MovieExports } from '../src/components/MovieExports';
import { episode } from './episodeFixtures';
import { movieHistoryQueryKey } from '../src/hooks/useMovieExportHistory';

// No generated hooks or fetch-client internals are mocked in this suite.
const exportsPath = '/api/studio/exports';
const preflight: StudioExportPreflight = {
  canQueue: true, message: 'Saved scripts fit.',
  cards: 12, cardLimit: 2000, playbackSeconds: 90, playbackLimitSeconds: 21600,
};
const queued: StudioExport = {
  id: 11, episodeId: null, aspectRatio: '16:9', quality: '720p',
  status: 'queued', progress: 0, url: null, error: null,
  createdAt: '2026-11-09T12:00:00Z',
};

let client: QueryClient;
let saved: StudioExport[];
let requests: { method: string; path: string; body: RequestInit['body'] }[];
let createResponse: () => Promise<Response>;
let unexpectedRequests: string[];
let olderPageFails: boolean;
let deletionFails: boolean;

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  saved = [];
  requests = [];
  unexpectedRequests = [];
  olderPageFails = deletionFails = false;
  createResponse = async () => {
    saved = [queued];
    return json(queued, 201);
  };
  client = new QueryClient({
    defaultOptions: {
      // A fresh cache must still refresh after creation; polling must not rely
      // on mount/focus/reconnect refetches or retries.
      queries: {
        retry: false, gcTime: Infinity, staleTime: Infinity,
        refetchOnWindowFocus: false, refetchOnReconnect: false,
      },
      mutations: { retry: false, gcTime: Infinity },
    },
  });
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    requests.push({ method, path, body: init?.body });
    if (method === 'GET' && (path === exportsPath || path.startsWith(`${exportsPath}?`))) {
      const cursor = new URL(path, 'http://test').searchParams.get('beforeId');
      if (cursor && olderPageFails) return json({ error: 'History temporarily unavailable' }, 503);
      return json(saved.filter(job => !cursor || job.id < Number(cursor)).slice(0, 100));
    }
    if (method === 'DELETE' && path.startsWith(`${exportsPath}/`)) {
      if (deletionFails) return json({ error: 'Could not delete movie' }, 503);
      saved = saved.filter(job => job.id !== Number(path.split('/').at(-1)));
      return new Response(null, { status: 204 });
    }
    if (method === 'GET' && path === `${exportsPath}/preflight?aspectRatio=16%3A9`) return json(preflight);
    if (method === 'POST' && path === exportsPath) return createResponse();
    unexpectedRequests.push(`${method} ${path}`);
    throw new Error(`Unexpected HTTP request: ${method} ${path}`);
  }));
});

afterEach(() => {
  // Unmount observers before clearing the cache and restoring real timers.
  cleanup();
  client.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  expect(unexpectedRequests).toEqual([]);
});

function mount() {
  render(<QueryClientProvider client={client}>
    <MovieExports episodes={[episode]} />
  </QueryClientProvider>);
}

// Flush HTTP promise continuations and React Query's scheduled notifications
// inside act, without real sleeps or waitFor advancing time implicitly.
async function advance(milliseconds: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
}

const listRequests = () => requests.filter(request => request.method === 'GET' && request.path === exportsPath);
const expectNoPreview = () => {
  expect(screen.queryByTestId('movie-preview')).not.toBeInTheDocument();
  expect(screen.queryByTestId('download-movie')).not.toBeInTheDocument();
};

describe('MovieExports with generated queries and mocked HTTP', () => {
  const history = () => Array.from({ length: 205 }, (_, index): StudioExport => ({
    ...queued, id: 205 - index, status: 'ready', progress: 100,
    url: `${exportsPath}/${205 - index}/file`,
  }));

  it('loads older pages, preserves selection through polling, and deletes across all cached pages', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    saved = history();
    mount();
    await advance(10);
    expect(screen.queryByTestId('movie-job-105')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('load-more-movies'));
    await advance(10);
    expect(screen.getByTestId('movie-job-6')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Saved movie preview'), { target: { value: '6' } });
    await advance(3000);
    expect(screen.getByTestId('movie-preview')).toHaveAttribute('src', `${exportsPath}/6/file`);

    // Include a generated page cache as well as the infinite history.
    const pageKey = getListStudioExportsQueryKey({ beforeId: 106 });
    client.setQueryData(pageKey, saved.filter(job => job.id < 106).slice(0, 100));
    // Prevent invalidation from hiding an incorrect local cache update.
    vi.spyOn(client, 'invalidateQueries').mockResolvedValue(undefined);
    fireEvent.click(screen.getByTestId('delete-movie-100'));
    await advance(10);
    expect(screen.queryByTestId('movie-job-100')).not.toBeInTheDocument();
    expect(client.getQueryData<StudioExport[]>(pageKey)?.some(job => job.id === 100)).toBe(false);
    expect(screen.getByTestId('movie-preview')).toHaveAttribute('src', `${exportsPath}/6/file`);

    fireEvent.click(screen.getByTestId('delete-movie-6'));
    await advance(10);
    expect(screen.queryByTestId('movie-job-6')).not.toBeInTheDocument();
    expect(screen.getByTestId('movie-preview')).toHaveAttribute('src', `${exportsPath}/205/file`);
    expect(screen.getByTestId('movie-job-205')).toBeVisible();
    // Even after deleting its last item, the old page retains cursor 6.
    fireEvent.click(screen.getByTestId('load-more-movies'));
    await advance(10);
    expect(requests.some(request => request.path === `${exportsPath}?beforeId=6`)).toBe(true);
    expect(screen.getByTestId('movie-job-1')).toBeVisible();
    expect(screen.queryByTestId('load-more-movies')).not.toBeInTheDocument();
  });

  it('keeps loaded previews on an older-page error and retries the same cursor', async () => {
    saved = history();
    mount();
    await advance(10);
    olderPageFails = true;
    fireEvent.click(screen.getByTestId('load-more-movies'));
    await advance(10);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load older movies');
    expect(screen.getByTestId('movie-preview')).toHaveAttribute('src', `${exportsPath}/205/file`);
    olderPageFails = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading older movies' }));
    await advance(10);
    expect(screen.getByTestId('movie-job-105')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('retains an older selected movie when deletion fails', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    saved = history();
    mount();
    await advance(10);
    fireEvent.click(screen.getByTestId('load-more-movies'));
    await advance(10);
    fireEvent.change(screen.getByLabelText('Saved movie preview'), { target: { value: '105' } });
    deletionFails = true;
    fireEvent.click(screen.getByTestId('delete-movie-105'));
    await advance(10);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not delete movie');
    expect(screen.getByTestId('movie-job-105')).toBeVisible();
    expect(screen.getByTestId('movie-preview')).toHaveAttribute('src', `${exportsPath}/105/file`);
    expect(screen.getByTestId('delete-movie-105')).toBeEnabled();
  });

  it('polls queued → rendering → ready and offers preview/download only when ready', async () => {
    saved = [queued];
    mount();
    await advance(10);
    expect(listRequests()).toHaveLength(1);
    expect(screen.getByTestId('movie-job-11')).toHaveTextContent('queued');
    expectNoPreview();

    saved = [{ ...queued, status: 'rendering', progress: 45 }];
    await advance(2989);
    expect(listRequests()).toHaveLength(1);
    expect(screen.getByTestId('movie-job-11')).toHaveTextContent('queued');

    await advance(11);
    expect(listRequests()).toHaveLength(2);
    expect(screen.getByTestId('movie-job-11')).toHaveTextContent('rendering 45%');
    expectNoPreview();

    const ready: StudioExport = {
      ...queued, status: 'ready', progress: 100, url: `${exportsPath}/11/file`,
    };
    saved = [ready];
    await advance(3000);
    expect(listRequests()).toHaveLength(3);
    expect(screen.getByTestId('movie-job-11')).toHaveTextContent('ready');
    expect(screen.getByTestId('movie-preview')).toHaveAttribute('src', ready.url);
    expect(screen.getByTestId('download-movie')).toHaveAttribute('href', ready.url);
    expect(screen.getByTestId('download-movie')).toHaveAttribute('download', 'storyboard-11-720p.mp4');
    expect(client.getQueryData(movieHistoryQueryKey())).toEqual({ pages: [{ items: [ready], nextCursor: undefined }], pageParams: [undefined] });
    // jsdom never fetches the media; only JSON endpoints may be requested.
    expect(requests.some(request => request.path.endsWith('/file'))).toBe(false);
  });

  it('refetches the fresh list after successful creation without waiting for a poll', async () => {
    let finishCreation!: () => void;
    createResponse = () => new Promise(resolve => {
      finishCreation = () => {
        saved = [queued];
        resolve(json(queued, 201));
      };
    });
    mount();
    await advance(10);
    expect(listRequests()).toHaveLength(1);
    expect(client.getQueryData(movieHistoryQueryKey())).toEqual({ pages: [{ items: [], nextCursor: undefined }], pageParams: [undefined] });
    expect(screen.queryByTestId('movie-job-11')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Build storyboard MP4' }));
    await advance(10);
    const posts = requests.filter(request => request.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].path).toBe(exportsPath);
    expect(JSON.parse(posts[0].body as string)).toEqual({
      episodeId: null, aspectRatio: '16:9', quality: '720p', requestId: expect.any(String),
    });
    expect(screen.getByRole('button', { name: 'Build storyboard MP4' })).toBeDisabled();
    expect(listRequests()).toHaveLength(1);
    expect(screen.queryByTestId('movie-job-11')).not.toBeInTheDocument();

    await act(async () => { finishCreation(); });
    await advance(10);
    // Only 30ms has elapsed, well before the 3000ms polling interval.
    // Assert the real HTTP refetch and rendered result, not an invalidate spy.
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /api/studio/exports/preflight?aspectRatio=16%3A9',
      'GET /api/studio/exports',
      'GET /api/studio/exports/preflight?aspectRatio=16%3A9',
      'POST /api/studio/exports',
      'GET /api/studio/exports',
    ]);
    expect(screen.getByTestId('movie-job-11')).toHaveTextContent('queued');
    expect(client.getQueryData(movieHistoryQueryKey())).toEqual({ pages: [{ items: [queued], nextCursor: undefined }], pageParams: [undefined] });
    expect(screen.getByRole('button', { name: 'Build storyboard MP4' })).toBeEnabled();
    expectNoPreview();
  });
});
