import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clip, StudioBootstrap } from '@workspace/api-client-react';
import App from '../src/App';
import { downloadEpisodeVideo } from '../src/lib/episodeDownload';
import { downloadSeriesPackage } from '../src/lib/seriesPackage';
import { bootstrap, clip, episode, otherEpisode, shot } from './episodeFixtures';

const state = vi.hoisted(() => ({ data: undefined as StudioBootstrap | undefined }));
vi.mock('@workspace/replit-auth-web', () => ({
  useAuth: () => ({ user: { id: 'creator', firstName: 'Creator' }, isLoading: false }),
}));
vi.mock('@workspace/api-client-react', async importOriginal => {
  const actual = await importOriginal<typeof import('@workspace/api-client-react')>();
  // Keep generated query keys/types intact; isolate unrelated mutation hooks.
  const mutations = Object.fromEntries(Object.keys(actual)
    .filter(name => name.startsWith('use') && name !== 'useGetStudioBootstrap')
    .map(name => [name, () => ({ mutate: vi.fn(), isPending: false })]));
  return {
    ...actual, ...mutations,
    useGetStudioBootstrap: () => ({ data: state.data, isLoading: false, isError: false }),
  };
});
vi.mock('../src/components/MovieExports', () => ({ MovieExports: () => null }));
vi.mock('../src/lib/episodeDownload', () => ({ downloadEpisodeVideo: vi.fn() }));
vi.mock('../src/lib/seriesPackage', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/seriesPackage')>(),
  downloadSeriesPackage: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const seriesControl = () => screen.getByTestId('button-export-series');
const seriesSuccess = 'Series package downloaded.';

const control = (id: number) => within(screen.getByTestId(`row-episode-${id}`))
  .getByRole('button', { name: /Download episode .* MP4/ });
const unavailable: Array<[string, Partial<Clip>]> = [
  ['queued', { status: 'queued' }],
  ['generating', { status: 'generating' }],
  ['failed', { status: 'failed' }],
  ['ready without a URL', { status: 'ready', url: null }],
  ['ready with an empty URL', { status: 'ready', url: '' }],
];

beforeEach(() => {
  state.data = structuredClone(bootstrap);
  vi.mocked(downloadEpisodeVideo).mockReset();
  vi.mocked(downloadSeriesPackage).mockReset();
});

describe('signed-in dashboard series ZIP wiring', () => {
  it.each(['resolve', 'reject'])('cancels ZIP independently and ignores a late %s during retry', async completion => {
    const cancelled = deferred<void>();
    const retry = deferred<void>();
    const assembling = deferred<Awaited<ReturnType<typeof downloadEpisodeVideo>>>();
    vi.mocked(downloadSeriesPackage)
      .mockReturnValueOnce(cancelled.promise)
      .mockReturnValueOnce(retry.promise);
    vi.mocked(downloadEpisodeVideo).mockReturnValue(assembling.promise);
    render(<App />);
    expect(screen.queryByRole('button', { name: 'Cancel ZIP export' })).not.toBeInTheDocument();
    fireEvent.click(control(episode.id));
    fireEvent.click(seriesControl());
    const zipSignal = vi.mocked(downloadSeriesPackage).mock.calls[0][1]!;
    const episodeSignal = vi.mocked(downloadEpisodeVideo).mock.calls[0][1]!;
    expect(zipSignal).not.toBe(episodeSignal);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel ZIP export' }));
    expect(zipSignal.aborted).toBe(true);
    expect(episodeSignal.aborted).toBe(false);
    expect(control(episode.id)).toBeDisabled();
    expect(seriesControl()).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Cancel ZIP export' })).not.toBeInTheDocument();
    expect(screen.getByTestId('status-toast')).toHaveTextContent('Series ZIP export cancelled. You can try again.');
    expect(screen.getByTestId('status-toast')).not.toHaveClass('error');

    fireEvent.click(seriesControl());
    const retrySignal = vi.mocked(downloadSeriesPackage).mock.calls[1][1]!;
    expect(retrySignal).not.toBe(zipSignal);
    expect(retrySignal.aborted).toBe(false);
    await act(async () => {
      if (completion === 'resolve') cancelled.resolve();
      else cancelled.reject(new Error('Late failure'));
    });
    expect(seriesControl()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel ZIP export' })).toBeVisible();
    expect(screen.queryByText(seriesSuccess)).not.toBeInTheDocument();
    expect(screen.queryByText('Late failure')).not.toBeInTheDocument();
    await act(async () => retry.resolve());
    expect(seriesControl()).toBeEnabled();
    expect(screen.getByTestId('status-toast')).toHaveTextContent(seriesSuccess);
    expect(control(episode.id)).toBeDisabled();
    await act(async () => assembling.resolve({ message: 'MP4 finished.', skippedClips: [] }));
    expect(screen.getByTestId(`status-episode-download-${episode.id}`)).toHaveTextContent('MP4 finished.');
  });

  it('ignores an abort rejection without replacing the cancellation notice', async () => {
    vi.mocked(downloadSeriesPackage).mockImplementation((_bootstrap, signal) => new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
    }));
    render(<App />);
    fireEvent.click(seriesControl());
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Cancel ZIP export' })));
    expect(seriesControl()).toBeEnabled();
    expect(screen.getByTestId('status-toast')).toHaveTextContent('Series ZIP export cancelled. You can try again.');
    expect(screen.getByTestId('status-toast')).not.toHaveClass('error');
  });

  it('aborts outstanding ZIP work when the studio unmounts', async () => {
    const packing = deferred<void>();
    vi.mocked(downloadSeriesPackage).mockReturnValue(packing.promise);
    const { unmount } = render(<App />);
    fireEvent.click(seriesControl());
    const signal = vi.mocked(downloadSeriesPackage).mock.calls[0][1]!;
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => packing.resolve());
  });

  it('packs the current bootstrap, blocks duplicate clicks, and reports success only after completion', async () => {
    const packing = deferred<void>();
    vi.mocked(downloadSeriesPackage).mockReturnValue(packing.promise);
    const { rerender } = render(<App />);
    expect(screen.getByTestId('view-dashboard')).toBeVisible();
    expect(seriesControl()).toBeEnabled();
    expect(seriesControl()).toHaveAccessibleName('Download series ZIP');

    // Export must use refreshed data, not the bootstrap from the initial render.
    const refreshed = {
      ...structuredClone(bootstrap),
      project: { ...bootstrap.project, title: 'Refreshed series' },
      episodes: [{ ...episode, title: 'Refreshed episode' }],
    };
    state.data = refreshed;
    rerender(<App />);
    fireEvent.click(seriesControl());

    expect(downloadSeriesPackage).toHaveBeenCalledExactlyOnceWith(refreshed, expect.any(AbortSignal));
    expect(vi.mocked(downloadSeriesPackage).mock.calls[0][0]).toBe(refreshed);
    expect(seriesControl()).toBeDisabled();
    expect(seriesControl()).toHaveAccessibleName('Packing…');
    expect(screen.queryByText(seriesSuccess)).not.toBeInTheDocument();
    expect(downloadEpisodeVideo).not.toHaveBeenCalled();
    fireEvent.click(seriesControl());
    expect(downloadSeriesPackage).toHaveBeenCalledTimes(1);

    await act(async () => packing.resolve());
    expect(screen.getByTestId('status-toast')).toHaveTextContent(seriesSuccess);
    expect(screen.getByText(seriesSuccess).closest('.toast')).not.toHaveClass('error');
    expect(seriesControl()).toBeEnabled();
    expect(seriesControl()).toHaveAccessibleName('Download series ZIP');
    expect(downloadEpisodeVideo).not.toHaveBeenCalled();
  });

  it.each([
    [new Error('Sign in again to export private references.'), 'Sign in again to export private references.'],
    ['unexpected rejection', 'The series package could not be created.'],
  ])('shows an explicit error and allows retry after rejection: %s', async (failure, message) => {
    const failed = deferred<void>();
    const retry = deferred<void>();
    vi.mocked(downloadSeriesPackage)
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(retry.promise);
    render(<App />);
    fireEvent.click(seriesControl());
    expect(seriesControl()).toBeDisabled();
    expect(screen.queryByText(seriesSuccess)).not.toBeInTheDocument();

    await act(async () => failed.reject(failure));
    expect(screen.getByTestId('status-toast')).toHaveTextContent(message);
    expect(screen.getByText(message).closest('.toast')).toHaveClass('error');
    expect(screen.queryByText(seriesSuccess)).not.toBeInTheDocument();
    expect(seriesControl()).toBeEnabled();
    expect(seriesControl()).toHaveAccessibleName('Download series ZIP');

    fireEvent.click(seriesControl());
    expect(downloadSeriesPackage).toHaveBeenCalledTimes(2);
    expect(downloadSeriesPackage).toHaveBeenNthCalledWith(2, state.data, expect.any(AbortSignal));
    expect(seriesControl()).toBeDisabled();
    expect(seriesControl()).toHaveAccessibleName('Packing…');
    expect(screen.queryByText(seriesSuccess)).not.toBeInTheDocument();

    await act(async () => retry.resolve());
    expect(screen.getByTestId('status-toast')).toHaveTextContent(seriesSuccess);
    expect(screen.queryByText(message)).not.toBeInTheDocument();
    expect(screen.getByText(seriesSuccess).closest('.toast')).not.toHaveClass('error');
    expect(seriesControl()).toBeEnabled();
    expect(seriesControl()).toHaveAccessibleName('Download series ZIP');
    expect(downloadEpisodeVideo).not.toHaveBeenCalled();
  });

  it.each(['ZIP', 'MP4'])('keeps overlapping ZIP and episode exports independent when %s finishes first', async first => {
    const packing = deferred<void>();
    const assembling = deferred<Awaited<ReturnType<typeof downloadEpisodeVideo>>>();
    const mp4Result = { message: 'Episode MP4 downloaded independently.', skippedClips: [] };
    vi.mocked(downloadSeriesPackage).mockReturnValue(packing.promise);
    vi.mocked(downloadEpisodeVideo).mockReturnValue(assembling.promise);
    render(<App />);

    // Exercise both initiation orders as well as both completion orders.
    if (first === 'ZIP') {
      fireEvent.click(seriesControl());
      expect(downloadEpisodeVideo).not.toHaveBeenCalled();
      expect(control(episode.id)).toBeEnabled();
      fireEvent.click(control(episode.id));
    } else {
      fireEvent.click(control(episode.id));
      expect(downloadSeriesPackage).not.toHaveBeenCalled();
      expect(seriesControl()).toBeEnabled();
      fireEvent.click(seriesControl());
    }
    expect(downloadSeriesPackage).toHaveBeenCalledExactlyOnceWith(state.data, expect.any(AbortSignal));
    expect(downloadEpisodeVideo).toHaveBeenCalledExactlyOnceWith(episode, expect.any(AbortSignal));
    expect(seriesControl()).toBeDisabled();
    expect(seriesControl()).toHaveAccessibleName('Packing…');
    expect(control(episode.id)).toBeDisabled();
    expect(control(episode.id)).toHaveTextContent('Assembling MP4…');

    const episodeStatus = screen.getByTestId(`status-episode-download-${episode.id}`);
    if (first === 'ZIP') {
      await act(async () => packing.resolve());
      expect(seriesControl()).toBeEnabled();
      expect(screen.getByTestId('status-toast')).toHaveTextContent(seriesSuccess);
      expect(control(episode.id)).toBeDisabled();
      expect(episodeStatus).toHaveTextContent('Assembling available clips');
      expect(episodeStatus).not.toHaveTextContent(seriesSuccess);
      await act(async () => assembling.resolve(mp4Result));
    } else {
      await act(async () => assembling.resolve(mp4Result));
      expect(control(episode.id)).toBeEnabled();
      expect(episodeStatus).toHaveTextContent(mp4Result.message);
      expect(seriesControl()).toBeDisabled();
      expect(seriesControl()).toHaveAccessibleName('Packing…');
      expect(screen.queryByText(seriesSuccess)).not.toBeInTheDocument();
      await act(async () => packing.resolve());
    }
    expect(seriesControl()).toBeEnabled();
    expect(seriesControl()).toHaveAccessibleName('Download series ZIP');
    expect(control(episode.id)).toBeEnabled();
    expect(episodeStatus).toHaveTextContent(mp4Result.message);
    expect(episodeStatus).not.toHaveTextContent(seriesSuccess);
    expect(screen.getByTestId('status-toast')).toHaveTextContent(seriesSuccess);
    expect(downloadSeriesPackage).toHaveBeenCalledTimes(1);
    expect(downloadEpisodeVideo).toHaveBeenCalledTimes(1);
  });
});

describe('signed-in dashboard episode download wiring', () => {
  it('enables only the episode owning a ready clip, not the active or unrelated episode', async () => {
    vi.mocked(downloadEpisodeVideo).mockResolvedValue({
      message: 'MP4 download started. No clips were skipped.', skippedClips: [],
    });
    render(<App />);
    expect(screen.getByTestId('view-dashboard')).toBeVisible();
    expect(control(episode.id)).toBeEnabled();
    expect(control(otherEpisode.id)).toBeDisabled();
    fireEvent.click(control(otherEpisode.id));
    expect(downloadEpisodeVideo).not.toHaveBeenCalled();
    fireEvent.click(control(episode.id));
    await screen.findByText('MP4 download started. No clips were skipped.');
    expect(downloadEpisodeVideo).toHaveBeenCalledExactlyOnceWith(episode, expect.any(AbortSignal));
  });

  it.each(unavailable)('does not enable an episode whose only clip is %s', (_label, changes) => {
    state.data = { ...bootstrap, clips: [{ ...clip, ...changes }] };
    render(<App />);
    for (const entry of bootstrap.episodes) {
      expect(control(entry.id)).toBeDisabled();
      expect(screen.getByTestId(`status-episode-download-${entry.id}`))
        .toHaveTextContent('No downloadable clips are available');
      fireEvent.click(control(entry.id));
    }
    expect(downloadEpisodeVideo).not.toHaveBeenCalled();
  });

  it('does not enable any episode for ready clips with broken shot or scene links', () => {
    state.data = {
      ...bootstrap,
      shots: [...bootstrap.shots, { ...shot, id: 999, sceneId: 9999 }],
      clips: [{ ...clip, shotId: 888 }, { ...clip, id: 302, shotId: 999 }],
    };
    render(<App />);
    expect(control(episode.id)).toBeDisabled();
    expect(control(otherEpisode.id)).toBeDisabled();
  });

  it('recomputes eligibility on refresh without moving a result to another episode', async () => {
    vi.mocked(downloadEpisodeVideo).mockResolvedValue({
      message: 'MP4 download started. 1 clip(s) skipped; details below.',
      skippedClips: [{ clipId: 19, provider: 'renderer', reason: 'Unavailable media' }],
    });
    const { rerender } = render(<App />);
    fireEvent.click(control(episode.id));
    await screen.findByText('Clip 19 (renderer): Unavailable media');
    state.data = {
      ...bootstrap, episodes: [...bootstrap.episodes].reverse(),
      clips: [{ ...clip, shotId: 202 }],
    };
    rerender(<App />);
    expect(control(episode.id)).toBeDisabled();
    expect(control(otherEpisode.id)).toBeEnabled();
    expect(screen.getByTestId(`status-episode-download-${episode.id}`)).toHaveTextContent('Unavailable media');
    expect(screen.getByTestId(`status-episode-download-${otherEpisode.id}`)).not.toHaveTextContent('Unavailable media');
  });

  it('renders unavailable controls safely with no clips, shots, or scenes', () => {
    state.data = { ...bootstrap, clips: [], shots: [], scenes: [] };
    render(<App />);
    expect(control(episode.id)).toBeDisabled();
    expect(control(otherEpisode.id)).toBeDisabled();
  });
});
