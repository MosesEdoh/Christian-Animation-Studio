import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setBaseUrl, type StudioExport } from '@workspace/api-client-react';
import ClipsScreen from '../app/(tabs)/clips';
import { mobileMovieHistoryQueryKey } from '../hooks/useMovieExportHistory';

vi.mock('react-native', () => ({
  View: ({ children }: any) => <div>{children}</div>,
  Text: ({ children, testID, accessibilityRole }: any) => <span data-testid={testID} role={accessibilityRole}>{children}</span>,
  TextInput: () => <input />,
  ActivityIndicator: ({ testID }: any) => <span data-testid={testID}>Loading</span>,
  Pressable: ({ children, testID, onPress, disabled, accessibilityState }: any) =>
    <button data-testid={testID} onClick={onPress} disabled={disabled} aria-pressed={accessibilityState?.selected}>{children}</button>,
}));
vi.mock('@/hooks/useColors', () => ({ useColors: () => ({}) }));
vi.mock('@/components/KeyboardAwareScrollViewCompat', () => ({
  KeyboardAwareScrollViewCompat: ({ children }: any) => <main>{children}</main>,
}));
// Keep the real generated API calls/query hooks. Only replace the native player
// boundary so selection can be checked without Expo's native runtime.
vi.mock('@/components/PrivateVideo', () => ({
  PrivateVideo: ({ url, label }: any) => <div data-testid="private-video" data-url={url}>{label}</div>,
}));

const makeMovie = (id: number): StudioExport => ({
  id, episodeId: null, aspectRatio: '16:9', quality: '720p',
  status: 'ready', progress: 100, url: `/api/studio/exports/${id}/file`,
  error: null, createdAt: '2026-11-10T00:00:00Z',
});
let saved: StudioExport[];
let requests: Array<number | undefined>;
let failCursor: number | undefined | null;
let client: QueryClient;
let release: (() => void) | undefined;
let pauseOlder: boolean;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  saved = Array.from({ length: 205 }, (_, index) => makeMovie(205 - index));
  requests = [];
  failCursor = null;
  pauseOlder = false;
  release = undefined;
  client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  setBaseUrl('https://mobile.example.test');
  globalThis.fetch = vi.fn(async input => {
    const url = new URL(String(input));
    if (url.pathname === '/api/studio/bootstrap') return Response.json({
      episodes: [], shots: [], clips: [],
    });
    if (url.pathname !== '/api/studio/exports') throw new Error(`Unexpected request: ${url}`);
    const cursor = url.searchParams.has('beforeId') ? Number(url.searchParams.get('beforeId')) : undefined;
    requests.push(cursor);
    if (pauseOlder && cursor !== undefined) await new Promise<void>(resolve => { release = resolve; });
    if (failCursor === cursor) return Response.json({ message: 'Unavailable' }, { status: 503 });
    return Response.json(saved.filter(job => cursor === undefined || job.id < cursor).slice(0, Number(url.searchParams.get('limit') ?? 100)));
  });
  render(<QueryClientProvider client={client}><ClipsScreen /></QueryClientProvider>);
});
afterEach(() => {
  client.clear();
  globalThis.fetch = originalFetch;
  setBaseUrl(null);
});

async function firstPage() {
  await screen.findByTestId('mobile-select-movie-106');
}
async function loadOlder() {
  fireEvent.click(screen.getByTestId('mobile-load-older-movies'));
  await screen.findByTestId('mobile-select-movie-6');
}
async function refresh() {
  await act(async () => { await client.invalidateQueries({ queryKey: mobileMovieHistoryQueryKey() }); });
  // Query observers batch their notifications on the next turn.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}

describe('mobile saved movie history', () => {
  it('renders the whole page and opens an older ready movie through PrivateVideo', async () => {
    await firstPage();
    expect(screen.getAllByTestId(/mobile-select-movie-/)).toHaveLength(100);
    await loadOlder();
    expect(requests).toEqual([undefined, 106]);
    fireEvent.click(screen.getByTestId('mobile-select-movie-6'));
    expect(screen.getByTestId('private-video')).toHaveAttribute('data-url', '/api/studio/exports/6/file');
    expect(screen.getByTestId('mobile-select-movie-6')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('mobile-load-older-movies'));
    await screen.findByTestId('mobile-movies-end');
    expect(requests).toEqual([undefined, 106, 6]);
    expect(screen.getAllByTestId(/mobile-select-movie-/)).toHaveLength(205);
    expect(screen.queryByTestId('mobile-load-older-movies')).not.toBeInTheDocument();
  });

  it('preserves every loaded movie and selection when new movies shift page boundaries', async () => {
    await firstPage();
    await loadOlder();
    fireEvent.click(screen.getByTestId('mobile-select-movie-6'));
    saved = [...Array.from({ length: 120 }, (_, i) => makeMovie(325 - i)), ...saved];
    await refresh();
    expect(screen.getAllByTestId(/mobile-select-movie-/)).toHaveLength(320);
    expect(screen.getByTestId('mobile-select-movie-6')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('private-video')).toHaveAttribute('data-url', '/api/studio/exports/6/file');
    // Refresh fills the expanded first window, keeping the second window fixed.
    expect(requests.slice(2)).toEqual([undefined, 226, 126, 106]);
  });

  it('retains movies during failed refreshes and retries the same older cursor after failure', async () => {
    await firstPage();
    failCursor = 106;
    fireEvent.click(screen.getByTestId('mobile-load-older-movies'));
    await screen.findByText('Retry older movies');
    expect(screen.getAllByTestId(/mobile-select-movie-/)).toHaveLength(100);
    failCursor = null;
    await loadOlder();
    fireEvent.click(screen.getByTestId('mobile-select-movie-6'));
    failCursor = undefined;
    await refresh();
    expect(screen.getAllByTestId(/mobile-select-movie-/)).toHaveLength(200);
    expect(screen.getByTestId('private-video')).toHaveAttribute('data-url', '/api/studio/exports/6/file');
    failCursor = null;
    fireEvent.click(screen.getByTestId('mobile-refresh-movies'));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(requests.filter(cursor => cursor === 106)).toHaveLength(3);
  });

  it('blocks repeated load-more requests and refresh until the older page finishes', async () => {
    await firstPage();
    pauseOlder = true;
    fireEvent.click(screen.getByTestId('mobile-load-older-movies'));
    await waitFor(() => expect(release).toBeTypeOf('function'));
    expect(screen.getByTestId('mobile-load-older-movies')).toBeDisabled();
    expect(screen.getByTestId('mobile-refresh-movies')).toBeDisabled();
    fireEvent.click(screen.getByTestId('mobile-load-older-movies'));
    expect(requests).toEqual([undefined, 106]);
    await act(async () => { release!(); });
    await screen.findByTestId('mobile-select-movie-6');
  });

  it('handles empty history and refreshes queued jobs without opening missing files', async () => {
    await firstPage();
    saved = [{ ...makeMovie(206), status: 'rendering', progress: 40, url: null }];
    await refresh();
    expect(screen.getByTestId('mobile-select-movie-206')).toBeDisabled();
    expect(screen.queryByTestId('private-video')).not.toBeInTheDocument();
    saved = [makeMovie(206)];
    await refresh();
    expect(screen.getByTestId('private-video')).toHaveAttribute('data-url', '/api/studio/exports/206/file');
    saved = [];
    await refresh();
    expect(screen.getByText(/No saved movies yet/)).toBeInTheDocument();
  });

  it('allows an empty final page after an exactly full page', async () => {
    await firstPage();
    saved = saved.slice(0, 100);
    fireEvent.click(screen.getByTestId('mobile-load-older-movies'));
    await screen.findByTestId('mobile-movies-end');
    expect(screen.getAllByTestId(/mobile-select-movie-/)).toHaveLength(100);
    expect(screen.queryByTestId('mobile-load-older-movies')).not.toBeInTheDocument();
  });

  it('keeps the tail and selected player when a fully loaded history grows past one page', async () => {
    await firstPage();
    saved = saved.slice(0, 50);
    await refresh();
    // The original cursor remains valid even when its boundary movie is deleted.
    fireEvent.click(screen.getByTestId('mobile-load-older-movies'));
    await screen.findByTestId('mobile-movies-end');
    fireEvent.click(screen.getByTestId('mobile-select-movie-156'));
    saved = [...Array.from({ length: 120 }, (_, i) => makeMovie(325 - i)), ...saved];
    await refresh();
    expect(screen.getAllByTestId(/mobile-select-movie-/)).toHaveLength(170);
    expect(screen.getByTestId('private-video')).toHaveAttribute('data-url', '/api/studio/exports/156/file');
    expect(screen.getByTestId('mobile-movies-end')).toBeInTheDocument();
  });

  it('polls older loaded statuses without replacing the selected ready movie', async () => {
    await firstPage();
    saved = saved.map(job => job.id === 7 ? { ...job, status: 'rendering', url: null } : job);
    await loadOlder();
    fireEvent.click(screen.getByTestId('mobile-select-movie-6'));
    expect(screen.getByTestId('mobile-select-movie-7')).toBeDisabled();
    saved = saved.map(job => job.id === 7 ? makeMovie(7) : job);
    await waitFor(() => expect(screen.getByTestId('mobile-select-movie-7')).toBeEnabled(), { timeout: 4500 });
    expect(screen.getByTestId('private-video')).toHaveAttribute('data-url', '/api/studio/exports/6/file');
  });
});
