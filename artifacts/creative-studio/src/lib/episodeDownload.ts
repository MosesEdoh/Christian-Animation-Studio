import { customFetch } from '@workspace/api-client-react';
export type EpisodeVideoIssue = { clipId: number; provider: string; reason: string };
export type EpisodeDownloadResult = {
  message: string;
  skippedClips: EpisodeVideoIssue[];
  failed?: boolean;
  busy?: boolean;
  retryable?: boolean;
};

function readIssues(value: unknown): EpisodeVideoIssue[] {
  if (!Array.isArray(value)) return [];
  return value.filter((issue): issue is EpisodeVideoIssue =>
    issue !== null && typeof issue === 'object' &&
    typeof issue.clipId === 'number' && typeof issue.provider === 'string' &&
    typeof issue.reason === 'string',
  );
}

// Uses only the single-episode endpoint: no ZIP, reference images, or other episodes.
export async function downloadEpisodeVideo(
  episode: { id: number; number: number; title: string },
  signal?: AbortSignal,
): Promise<EpisodeDownloadResult> {
  try {
    signal?.throwIfAborted();
    const response = await customFetch<Response>(`/api/studio/episodes/${episode.id}/video`, {
      responseType: 'response',
      credentials: 'include',
      signal,
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      signal?.throwIfAborted();
      if (response.status === 503 && failure.code === 'EPISODE_EXPORT_BUSY') {
        const seconds = Number(response.headers.get('retry-after') ?? failure.retryAfterSeconds);
        const retryAfter = Number.isInteger(seconds) && seconds > 0 && seconds <= 300 ? seconds : 15;
        return {
          failed: true,
          busy: true,
          message: `Episode exports are busy. Try again in ${retryAfter} seconds. Your export was not queued.`,
          skippedClips: [],
        };
      }
      if (response.status === 503 && failure.code === 'EPISODE_EXPORT_ADMISSION_UNAVAILABLE') {
        const seconds = Number(response.headers.get('retry-after') ?? failure.retryAfterSeconds);
        const retryAfter = Number.isInteger(seconds) && seconds > 0 && seconds <= 300 ? seconds : 15;
        return {
          failed: true,
          retryable: true,
          message: typeof failure.error === 'string'
            ? failure.error
            : `Episode export capacity is temporarily unavailable. Please retry in ${retryAfter} seconds.`,
          skippedClips: [],
        };
      }
      return {
        failed: true,
        message: response.status === 401
          ? 'Sign in again to download this episode.'
          : typeof failure.error === 'string'
            ? failure.error
            : `The episode MP4 could not be created (${response.status}). Try again.`,
        skippedClips: readIssues(failure.skippedClips),
      };
    }
    if (!response.headers.get('content-type')?.toLowerCase().includes('video/mp4')) {
      throw new Error('The episode service did not return an MP4. Try again.');
    }
    const blob = await response.blob();
    signal?.throwIfAborted();
    if (!blob.size) throw new Error('The episode export returned an empty video. Try again.');
    let skippedClips: EpisodeVideoIssue[] = [];
    let reportUnavailable = false;
    try {
      const encoded = response.headers.get('x-episode-video-report');
      if (!encoded) throw new Error('Missing clip report');
      const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      const report = JSON.parse(new TextDecoder().decode(bytes));
      if (!Array.isArray(report.skippedClips)) throw new Error('Invalid clip report');
      skippedClips = readIssues(report.skippedClips);
    } catch {
      reportUnavailable = true;
    }
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    const title = episode.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').trim() || 'untitled';
    anchor.download = `E${String(episode.number).padStart(2, '0')}-${title}.mp4`;
    try {
      anchor.click();
    } finally {
      // Give the browser time to start reading the download before releasing it.
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    return {
      message: reportUnavailable
        ? 'MP4 download started, but the clip report could not be read. Some clips may have been skipped.'
        : skippedClips.length
          ? `MP4 download started. ${skippedClips.length} clip(s) skipped; details below.`
          : 'MP4 download started. No clips were skipped.',
      skippedClips,
    };
  } catch (error) {
    if (signal?.aborted) {
      return { message: 'Export cancelled. You can try again.', skippedClips: [] };
    }
    return {
      failed: true,
      message: error instanceof TypeError
        ? 'The episode video service could not be reached. Check your connection and try again.'
        : error instanceof Error ? error.message : 'The episode MP4 could not be downloaded. Try again.',
      skippedClips: [],
    };
  }
}
