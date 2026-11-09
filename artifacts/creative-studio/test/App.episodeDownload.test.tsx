import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clip, StudioBootstrap } from '@workspace/api-client-react';
import App from '../src/App';
import { downloadEpisodeVideo } from '../src/lib/episodeDownload';
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
    expect(downloadEpisodeVideo).toHaveBeenCalledExactlyOnceWith(episode);
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
