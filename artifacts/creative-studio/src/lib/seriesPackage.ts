import { strToU8 } from 'fflate';
import { compressArchive } from './zipArchive';
import type { StudioBootstrap } from '@workspace/api-client-react';
import { customFetch } from '@workspace/api-client-react';

export function assetSrc(objectPath: string): string {
  return objectPath.startsWith('/objects/') ? `/api/storage${objectPath}` : objectPath;
}

const MAX_VIDEO_BYTES = 250 * 1024 * 1024;
const safeName = (value: string) =>
  value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').trim() || 'untitled';

// Separate archive creation from the browser download so tests inspect the real ZIP.
export async function buildSeriesPackage(
  bootstrap: StudioBootstrap,
  options: { maxVideoBytes?: number; origin?: string; signal?: AbortSignal } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const { signal } = options;
  signal?.throwIfAborted();
  const files: Record<string, Uint8Array> = {};
  const episodeVideoReports: string[] = [];
  const maxVideoBytes = options.maxVideoBytes ?? MAX_VIDEO_BYTES;
  const origin = options.origin ?? window.location.origin;
  let packagedEpisodeVideoBytes = 0;
  const episodes: Array<Record<string, unknown>> = [];

  for (const episode of bootstrap.episodes) {
    signal?.throwIfAborted();
    const episodeScenes = bootstrap.scenes
      .filter((scene) => scene.episodeId === episode.id)
      .sort((a, b) => a.number - b.number);
    const sceneOrder = new Map(episodeScenes.map((scene, index) => [scene.id, index]));
    const episodeShots = bootstrap.shots
      .filter((shot) => sceneOrder.has(shot.sceneId))
      .sort((a, b) => sceneOrder.get(a.sceneId)! - sceneOrder.get(b.sceneId)! || a.number - b.number);
    const episodeClips = bootstrap.clips.filter((clip) =>
      episodeShots.some((shot) => shot.id === clip.shotId),
    );
    const folder = `episodes/E${String(episode.number).padStart(2, '0')}-${safeName(episode.title)}`;
    files[`${folder}/script.txt`] = strToU8([
      `${bootstrap.project.title} — EPISODE ${String(episode.number).padStart(2, '0')}: ${episode.title}`,
      episode.summary, '',
      ...episodeScenes.flatMap((scene) => [
        scene.heading, scene.synopsis, '', scene.content, '',
      ]),
    ].join('\n'));
    files[`${folder}/shot-list.json`] = strToU8(JSON.stringify(
      episodeShots.map((shot) => ({
        ...shot,
        sceneHeading: episodeScenes.find((scene) => scene.id === shot.sceneId)?.heading,
        clips: episodeClips.filter((clip) => clip.shotId === shot.id),
      })), null, 2,
    ));
    const videoPath = `${folder}/episode.mp4`;
    const videoReportPath = `${folder}/episode-video-report.txt`;
    let videoStatus = 'unavailable';
    let includedVideoPath: string | null = null;
    let usedClipIds: number[] = [];
    let skippedClips: Array<{ clipId: number; provider: string; reason: string }> = [];
    let videoMessage = 'No downloadable clips are available for this episode.';
    try {
      const response = await customFetch<Response>(`/api/studio/episodes/${episode.id}/video`, {
        responseType: 'response',
        credentials: 'include',
        signal,
      });
      signal?.throwIfAborted();
      if (response.ok) {
        const blob = await response.blob();
        signal?.throwIfAborted();
        const encodedReport = response.headers.get('x-episode-video-report');
        if (encodedReport) {
          try {
            const reportBytes = Uint8Array.from(atob(encodedReport), (character) => character.charCodeAt(0));
            const report = JSON.parse(new TextDecoder().decode(reportBytes)) as {
              usedClipIds?: number[];
              skippedClips?: Array<{ clipId: number; provider: string; reason: string }>;
            };
            usedClipIds = report.usedClipIds ?? [];
            skippedClips = report.skippedClips ?? [];
          } catch {
            skippedClips.push({
              clipId: 0, provider: 'export',
              reason: 'The MP4 was created, but its clip report could not be read.',
            });
          }
        }
        if (!blob.size) {
          videoMessage = 'The episode export returned an empty video.';
        } else if (packagedEpisodeVideoBytes + blob.size > maxVideoBytes) {
          videoStatus = 'not-included-size-limit';
          videoMessage = 'The series ZIP video-size limit was reached; this episode MP4 was not added.';
        } else {
          files[videoPath] = new Uint8Array(await blob.arrayBuffer());
          signal?.throwIfAborted();
          packagedEpisodeVideoBytes += blob.size;
          includedVideoPath = videoPath;
          videoStatus = skippedClips.length ? 'partial' : 'ready';
          videoMessage = skippedClips.length
            ? 'MP4 included with one or more unavailable clips skipped.'
            : 'MP4 assembled from all available clips.';
        }
      } else {
        const failure = await response.json().catch(() => ({})) as {
          error?: string;
          skippedClips?: Array<{ clipId: number; provider: string; reason: string }>;
        };
        signal?.throwIfAborted();
        videoMessage = failure.error ?? `Episode video export failed (${response.status}).`;
        skippedClips = failure.skippedClips ?? [];
      }
    } catch {
      signal?.throwIfAborted();
      videoMessage = 'The episode video service could not be reached; no MP4 was included.';
    }
    if (!skippedClips.length && episodeClips.length) {
      skippedClips = episodeClips
        .filter((clip) => !usedClipIds.includes(clip.id))
        .map((clip) => ({
          clipId: clip.id, provider: clip.provider,
          reason: clip.status !== 'ready'
            ? `Clip is ${clip.status}, not ready for export.`
            : clip.url
              ? 'The provider-hosted clip could not be downloaded for episode assembly.'
              : 'The provider did not provide a downloadable video URL.',
        }));
    }
    const clipDetails = skippedClips.map((clip) =>
      `- Clip ${clip.clipId}${clip.provider === 'export' ? '' : ` (${clip.provider})`}: ${clip.reason}`,
    );
    files[videoReportPath] = strToU8([
      `Episode ${episode.number}: ${episode.title}`, `Status: ${videoStatus}`,
      videoMessage,
      includedVideoPath ? `Video: ${includedVideoPath}` : 'Video: not included',
      usedClipIds.length ? `Clips assembled: ${usedClipIds.map((id) => `#${id}`).join(', ')}` : 'Clips assembled: none',
      skippedClips.length ? 'Clips unavailable or skipped:' : '', ...clipDetails, '',
      'Provider-hosted links, when present, are listed in clip-links.txt and the series manifest.',
    ].filter(Boolean).join('\n'));
    episodeVideoReports.push(
      `Episode ${episode.number} — ${episode.title}: ${videoStatus}${includedVideoPath ? ` (${includedVideoPath})` : ''}`,
    );
    episodes.push({
      number: episode.number, title: episode.title, summary: episode.summary,
      status: episode.status, progress: episode.progress, duration: episode.duration,
      script: `${folder}/script.txt`, shotList: `${folder}/shot-list.json`,
      video: includedVideoPath, videoStatus, videoReport: videoReportPath,
      usedClipIds, unavailableVideoClips: skippedClips,
    });
  }

  files['character-bible.json'] = strToU8(JSON.stringify(bootstrap.characters, null, 2));
  files['series-manifest.json'] = strToU8(JSON.stringify({
    project: bootstrap.project, episodes, clips: bootstrap.clips,
    references: bootstrap.assets.map((asset) => ({
      ...asset, file: `references/${String(asset.id).padStart(4, '0')}-${safeName(asset.name)}`,
    })),
  }, null, 2));
  files['README.txt'] = strToU8([
    `${bootstrap.project.title} — series production package`, '',
    'Included: episode scripts, shot lists, character bible, uploaded references, downloadable provider clips, and assembled episode MP4s when clips are available.',
    'Each episode has an episode-video-report.txt that lists clips used and clips skipped or unavailable.',
    'Provider-hosted clips that cannot be fetched by the browser are listed in clip-links.txt and series-manifest.json.',
    'A mock provider records jobs but does not create video files.',
  ].join('\n'));

  const clipLinks: string[] = [];
  for (const asset of bootstrap.assets) {
    signal?.throwIfAborted();
    const response = await customFetch<Response>(assetSrc(asset.objectPath), { responseType: 'response', credentials: 'include', signal });
    signal?.throwIfAborted();
    if (!response.ok) {
      throw new Error(response.status === 401
        ? 'Sign in again to include private reference images in the download.'
        : `Could not download reference image: ${asset.name}`);
    }
    files[`references/${String(asset.id).padStart(4, '0')}-${safeName(asset.name)}`] =
      new Uint8Array(await response.arrayBuffer());
    signal?.throwIfAborted();
  }

  let downloadedVideoBytes = 0;
  for (const clip of bootstrap.clips) {
    signal?.throwIfAborted();
    if (!clip.url) continue;
    const fileName = `clip-${String(clip.id).padStart(4, '0')}`;
    try {
      const clipUrl = new URL(clip.url, origin);
      if (clipUrl.protocol !== 'https:' && clipUrl.origin !== origin) {
        throw new Error('Unsupported video URL');
      }
      const response = await customFetch<Response>(clipUrl, { responseType: 'response', credentials: clipUrl.origin === origin ? 'include' : 'omit', signal });
      signal?.throwIfAborted();
      const contentLength = Number(response.headers.get('content-length') ?? 0);
      if (!response.ok || (contentLength && downloadedVideoBytes + contentLength > maxVideoBytes)) {
        throw new Error('Video is not directly downloadable');
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      signal?.throwIfAborted();
      if (!bytes.length || downloadedVideoBytes + bytes.length > maxVideoBytes) {
        throw new Error('Video is larger than the export limit');
      }
      downloadedVideoBytes += bytes.length;
      const mime = response.headers.get('content-type') ?? '';
      const extension = mime.includes('webm') ? 'webm' : mime.includes('quicktime') ? 'mov' : 'mp4';
      files[`clips/${fileName}.${extension}`] = bytes;
    } catch {
      signal?.throwIfAborted();
      clipLinks.push(`Clip ${clip.id} (${clip.provider}, ${clip.status}): ${clip.url}`);
    }
  }
  if (clipLinks.length) files['clip-links.txt'] = strToU8(clipLinks.join('\n'));
  if (episodeVideoReports.length) {
    files['episode-video-reports.txt'] = strToU8(episodeVideoReports.join('\n'));
  }
  signal?.throwIfAborted();
  return compressArchive(files, signal);
}

export async function downloadSeriesPackage(bootstrap: StudioBootstrap, signal?: AbortSignal): Promise<void> {
  const archive = await buildSeriesPackage(bootstrap, { signal });
  signal?.throwIfAborted();
  const url = URL.createObjectURL(new Blob([archive], { type: 'application/zip' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${safeName(bootstrap.project.title)}-series-package.zip`;
  try {
    signal?.throwIfAborted();
    anchor.click();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
