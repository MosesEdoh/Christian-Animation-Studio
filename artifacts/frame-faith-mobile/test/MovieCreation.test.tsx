import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setBaseUrl, type StudioExport, type StudioExportInput } from '@workspace/api-client-react';
import ClipsScreen from '../app/(tabs)/clips';

vi.mock('expo-crypto', () => ({ randomUUID: () => crypto.randomUUID() }));
vi.mock('react-native', () => ({
  View: ({ children }: any) => <div>{children}</div>,
  Text: ({ children, accessibilityRole }: any) => <span role={accessibilityRole}>{children}</span>,
  TextInput: () => <input />,
  ActivityIndicator: () => <span>Loading</span>,
  Pressable: ({ children, testID, onPress, disabled }: any) =>
    <button data-testid={testID} onClick={onPress} disabled={disabled}>{children}</button>,
}));
vi.mock('@/hooks/useColors', () => ({ useColors: () => ({}) }));
vi.mock('@/components/KeyboardAwareScrollViewCompat', () => ({
  KeyboardAwareScrollViewCompat: ({ children }: any) => <main>{children}</main>,
}));
vi.mock('@/components/PrivateVideo', () => ({ PrivateVideo: () => null }));
vi.mock('@/components/VoicedEpisodePreview', () => ({ VoicedEpisodePreview: () => null }));

let client: QueryClient;
let sent: StudioExportInput[];
let saved: Map<string, StudioExport>;
let loseResponseAt: number | undefined;
let holdResponse: (() => Promise<void>) | undefined;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  sent = [];
  saved = new Map();
  loseResponseAt = undefined;
  holdResponse = undefined;
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  setBaseUrl('https://mobile.example.test');
  // Exercise the real generated mutation and its serialized StudioExportInput.
  globalThis.fetch = vi.fn(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/studio/bootstrap') return Response.json({
      episodes: [{ id: 1, number: 1, title: 'First' }, { id: 2, number: 2, title: 'Second' }],
      scenes: [], shots: [], clips: [],
    });
    if (url.pathname !== '/api/studio/exports') throw new Error(`Unexpected request: ${url}`);
    if (init?.method !== 'POST') return Response.json([...saved.values()]);
    const data: StudioExportInput = JSON.parse(String(init.body));
    sent.push(data);
    if (!data.requestId) throw new Error('Missing requestId');
    let movie = saved.get(data.requestId);
    if (!movie) {
      movie = { ...data, id: saved.size + 1, status: 'ready', progress: 100,
        url: null, sizeBytes: 123, error: null, createdAt: '2026-11-10T00:00:00Z' };
      saved.set(data.requestId, movie);
    }
    if (holdResponse) await holdResponse();
    // The server has accepted (and even finished) the job before the connection drops.
    if (sent.length === loseResponseAt) throw new TypeError('Network response lost');
    return Response.json(movie);
  });
  render(<QueryClientProvider client={client}><ClipsScreen /></QueryClientProvider>);
});

afterEach(() => {
  client.clear();
  globalThis.fetch = originalFetch;
  setBaseUrl(null);
});

async function build() {
  const button = await screen.findByTestId('mobile-build-movies');
  fireEvent.click(button);
  await waitFor(() => expect(button).toBeEnabled());
}

describe('mobile movie creation intents', () => {
  it.each([1, 2, 3, 4])('recovers a lost response at format %i without duplicating confirmed formats', async lostAt => {
    loseResponseAt = lostAt;
    await build();
    await screen.findByRole('alert');
    const unconfirmed = sent[lostAt - 1];
    expect(saved.size).toBe(lostAt);
    expect(screen.getByTestId('mobile-build-movies')).toHaveTextContent('Retry MP4 build');
    await build();
    expect(sent[lostAt]).toEqual(unconfirmed);
    expect(sent).toHaveLength(5);
    expect(saved.size).toBe(4);
    expect([...saved.values()].map(({ aspectRatio, quality }) => [aspectRatio, quality])).toEqual([
      ['16:9', '720p'], ['16:9', '1080p'], ['9:16', '720p'], ['9:16', '1080p'],
    ]);
    expect(new Set(sent.map(data => data.requestId)).size).toBe(4);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('uses fresh IDs for deliberate rebuilds, even with identical inputs', async () => {
    await build();
    const firstIds = sent.map(data => data.requestId);
    await build();
    expect(saved.size).toBe(8);
    expect(sent.slice(4).every(data => !firstIds.includes(data.requestId))).toBe(true);
    expect(sent.every(data => /^[A-Za-z0-9_-]{1,128}$/.test(data.requestId!))).toBe(true);
  });

  it('preserves the unfinished intent separately when switching episodes and series', async () => {
    fireEvent.click(await screen.findByText('Episode 1: First'));
    loseResponseAt = 2;
    await build();
    const unconfirmed = sent[1];
    fireEvent.click(screen.getByText('Entire series · one MP4'));
    await build();
    expect(sent.slice(2).every(data => data.episodeId === null)).toBe(true);
    fireEvent.click(screen.getByText('Episode 2: Second'));
    await build();
    expect(sent.slice(6).every(data => data.episodeId === 2)).toBe(true);
    fireEvent.click(screen.getByText('Episode 1: First'));
    await build();
    expect(sent[10]).toEqual(unconfirmed);
    expect(saved.size).toBe(12);
    expect(sent).toHaveLength(13);
  });

  it('keeps the whole batch busy and ignores overlapping presses', async () => {
    let release!: () => void;
    holdResponse = () => new Promise<void>(resolve => { release = resolve; });
    const button = await screen.findByTestId('mobile-build-movies');
    fireEvent.click(button);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(sent).toHaveLength(1);
    holdResponse = undefined;
    await act(async () => { release(); });
    await waitFor(() => expect(button).toBeEnabled());
    expect(saved.size).toBe(4);
    expect(sent).toHaveLength(4);
  });
});
