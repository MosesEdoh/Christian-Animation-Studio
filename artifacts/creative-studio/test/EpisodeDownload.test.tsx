import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EpisodeDownload } from '../src/components/EpisodeDownload';
import { downloadEpisodeVideo, type EpisodeDownloadResult } from '../src/lib/episodeDownload';
import { episode, otherEpisode } from './episodeFixtures';

vi.mock('../src/lib/episodeDownload', () => ({ downloadEpisodeVideo: vi.fn() }));
const download = vi.mocked(downloadEpisodeVideo);
const success: EpisodeDownloadResult = {
  message: 'MP4 download started. No clips were skipped.', skippedClips: [],
};
const partial: EpisodeDownloadResult = {
  message: 'MP4 download started. 2 clip(s) skipped; details below.',
  skippedClips: [
    { clipId: 9, provider: 'renderer', reason: 'Le clip a échoué.' },
    { clipId: 10, provider: 'mock', reason: 'No video URL is available.' },
  ],
};
const button = () => screen.getByRole('button', { name: 'Download episode 3 MP4' });
const status = () => screen.getByTestId(`status-episode-download-${episode.id}`);

beforeEach(() => { download.mockReset(); });

describe('EpisodeDownload controls', () => {
  it('shows busy/retry feedback, leaves no spinner or cancel button, and permits a manual retry', async () => {
    const message = 'Episode exports are busy. Try again in 15 seconds. Your export was not queued.';
    download.mockResolvedValueOnce({ failed: true, busy: true, message, skippedClips: [] })
      .mockResolvedValueOnce(success);
    render(<EpisodeDownload episode={episode} hasClips />);
    fireEvent.click(button());
    expect(await screen.findByText(message)).toBeVisible();
    expect(button()).toBeEnabled();
    expect(button()).toHaveTextContent('Retry MP4');
    expect(screen.queryByRole('button', { name: 'Cancel episode 3 export' })).not.toBeInTheDocument();
    expect(download).toHaveBeenCalledTimes(1);
    fireEvent.click(button());
    expect(await screen.findByText(success.message)).toBeVisible();
    expect(button()).toHaveTextContent('Download MP4');
    expect(download).toHaveBeenCalledTimes(2);
  });

  it('shows capacity-check outages as retryable and succeeds on a later attempt', async () => {
    const message = 'Episode export capacity is temporarily unavailable. Please retry in 15 seconds.';
    download.mockResolvedValueOnce({ failed: true, retryable: true, message, skippedClips: [] })
      .mockResolvedValueOnce(success);
    render(<EpisodeDownload episode={episode} hasClips />);
    fireEvent.click(button());
    expect(await screen.findByText(message)).toBeVisible();
    expect(button()).toBeEnabled();
    expect(button()).toHaveTextContent('Retry MP4');
    expect(screen.queryByRole('button', { name: 'Cancel episode 3 export' })).not.toBeInTheDocument();

    fireEvent.click(button());
    expect(await screen.findByText(success.message)).toBeVisible();
    expect(button()).toHaveTextContent('Download MP4');
    expect(download).toHaveBeenCalledTimes(2);
  });

  it('cancels immediately, allows retry, and ignores a stale completion', async () => {
    let finish!: (result: EpisodeDownloadResult) => void;
    let retryFinish!: (result: EpisodeDownloadResult) => void;
    download.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
      .mockReturnValueOnce(new Promise(resolve => { retryFinish = resolve; }));
    render(<EpisodeDownload episode={episode} hasClips />);
    fireEvent.click(button());
    const signal = download.mock.calls[0][1]!;
    fireEvent.click(screen.getByRole('button', { name: 'Cancel episode 3 export' }));
    expect(signal.aborted).toBe(true);
    expect(button()).toBeEnabled();
    expect(status()).toHaveTextContent('Export cancelled. You can try again.');
    fireEvent.click(button());
    await act(async () => finish({ failed: true, message: 'Old failure', skippedClips: [] }));
    expect(button()).toBeDisabled();
    expect(status()).not.toHaveTextContent('Old failure');
    await act(async () => retryFinish(success));
    expect(status()).toHaveTextContent(success.message);
    expect(button()).toBeEnabled();
  });

  it('aborts an export when its controls unmount', () => {
    download.mockReturnValue(new Promise(() => {}));
    const { unmount } = render(<EpisodeDownload episode={episode} hasClips />);
    fireEvent.click(button());
    const signal = download.mock.calls[0][1]!;
    unmount();
    expect(signal.aborted).toBe(true);
  });

  it('disables unavailable downloads and explains how to make them available', () => {
    render(<EpisodeDownload episode={episode} hasClips={false} />);
    expect(button()).toBeDisabled();
    expect(status()).toHaveTextContent('No downloadable clips are available');
    fireEvent.click(button());
    expect(download).not.toHaveBeenCalled();
  });

  it('shows assembly progress, blocks same-tick and later duplicate clicks, then unlocks', async () => {
    let finish!: (result: EpisodeDownloadResult) => void;
    download.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    render(<EpisodeDownload episode={episode} hasClips />);
    expect(button()).toBeEnabled();
    // Both events occur before React commits pending=true, exercising the ref guard.
    act(() => {
      button().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      button().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(download).toHaveBeenCalledExactlyOnceWith(episode, expect.any(AbortSignal));
    expect(button()).toBeDisabled();
    expect(button()).toHaveTextContent('Assembling MP4…');
    expect(status()).toHaveTextContent('Assembling available clips in story order');
    fireEvent.click(button());
    expect(download).toHaveBeenCalledTimes(1);
    await act(async () => finish(success));
    expect(button()).toBeEnabled();
    expect(button()).toHaveTextContent('Download MP4');
    expect(status()).toHaveTextContent(success.message);
    expect(status()).toHaveAttribute('aria-live', 'polite');
  });

  it('keeps partial-skip details visible after time passes and parent refreshes', async () => {
    vi.useFakeTimers();
    try {
      download.mockResolvedValue(partial);
      const { rerender } = render(<EpisodeDownload episode={episode} hasClips />);
      await act(async () => fireEvent.click(button()));
      expect(status()).toHaveTextContent(partial.message);
      const list = screen.getByTestId(`list-episode-skipped-clips-${episode.id}`);
      expect(within(list).getAllByRole('listitem')).toHaveLength(2);
      expect(list).toHaveTextContent('Clip 9 (renderer): Le clip a échoué.');
      expect(list).toHaveTextContent('Clip 10 (mock): No video URL is available.');
      act(() => vi.advanceTimersByTime(60_000));
      rerender(<EpisodeDownload episode={{ ...episode, progress: 50 }} hasClips={false} />);
      expect(status()).toHaveTextContent(partial.message);
      expect(screen.getByTestId(`list-episode-skipped-clips-${episode.id}`)).toHaveTextContent('Le clip a échoué.');
      expect(button()).toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    'Sign in again to download this episode.',
    'The episode MP4 could not be created (502). Try again.',
    'The episode video service could not be reached. Check your connection and try again.',
  ])('allows retry after an error: %s', async message => {
    download.mockResolvedValueOnce({ failed: true, message, skippedClips: partial.skippedClips })
      .mockResolvedValueOnce(success);
    render(<EpisodeDownload episode={episode} hasClips />);
    fireEvent.click(button());
    expect(await screen.findByText(message)).toBeVisible();
    expect(button()).toBeEnabled();
    expect(screen.getByTestId(`list-episode-skipped-clips-${episode.id}`)).toBeVisible();
    fireEvent.click(button());
    expect(status()).toHaveTextContent('Assembling available clips');
    expect(screen.queryByTestId(`list-episode-skipped-clips-${episode.id}`)).not.toBeInTheDocument();
    expect(await screen.findByText(success.message)).toBeVisible();
    expect(download).toHaveBeenCalledTimes(2);
    expect(download).toHaveBeenNthCalledWith(2, episode, expect.any(AbortSignal));
    expect(button()).toBeEnabled();
    expect(status()).not.toHaveTextContent(message);
  });

  it('keeps another episode usable and its status separate during an export', async () => {
    let finish!: (result: EpisodeDownloadResult) => void;
    download.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
      .mockResolvedValueOnce(success);
    render(<><EpisodeDownload episode={episode} hasClips /><EpisodeDownload episode={otherEpisode} hasClips /></>);
    fireEvent.click(button());
    const otherButton = screen.getByRole('button', { name: 'Download episode 4 MP4' });
    expect(otherButton).toBeEnabled();
    fireEvent.click(otherButton);
    await screen.findByText(success.message);
    expect(download).toHaveBeenNthCalledWith(2, otherEpisode, expect.any(AbortSignal));
    expect(button()).toBeDisabled();
    expect(status()).not.toHaveTextContent(success.message);
    await act(async () => finish(partial));
    expect(status()).toHaveTextContent(partial.message);
    expect(screen.getByTestId(`status-episode-download-${otherEpisode.id}`)).not.toHaveTextContent('skipped; details');
  });
});
