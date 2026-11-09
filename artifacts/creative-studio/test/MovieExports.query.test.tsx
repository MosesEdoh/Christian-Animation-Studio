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
    if (method === 'GET' && path === exportsPath) return json(saved);
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
    expect(client.getQueryData(getListStudioExportsQueryKey())).toEqual([ready]);
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
    expect(client.getQueryData(getListStudioExportsQueryKey())).toEqual([]);
    expect(screen.queryByTestId('movie-job-11')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Build storyboard MP4' }));
    await advance(10);
    const posts = requests.filter(request => request.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].path).toBe(exportsPath);
    expect(JSON.parse(posts[0].body as string)).toEqual({
      episodeId: null, aspectRatio: '16:9', quality: '720p',
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
    expect(client.getQueryData(getListStudioExportsQueryKey())).toEqual([queued]);
    expect(screen.getByRole('button', { name: 'Build storyboard MP4' })).toBeEnabled();
    expectNoPreview();
  });
});
