import { useEffect, useRef, useState } from 'react';
import { Download, LoaderCircle } from 'lucide-react';
import type { Episode } from '@workspace/api-client-react';
import { downloadEpisodeVideo, previewEpisodeVideo, type EpisodeDownloadResult, type EpisodeVideoIssue } from '../lib/episodeDownload';

export function EpisodeDownload({ episode, hasClips }: { episode: Episode; hasClips: boolean }) {
  const inFlight = useRef<AbortController | null>(null);
  const previewInFlight = useRef<AbortController | null>(null);
  const previewUrlRef = useRef('');
  const [pending, setPending] = useState(false);
  const [previewPending, setPreviewPending] = useState(false);
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewIssues, setPreviewIssues] = useState<EpisodeVideoIssue[]>([]);
  const [previewError, setPreviewError] = useState('');
  const [result, setResult] = useState<EpisodeDownloadResult | null>(null);

  useEffect(() => () => {
    inFlight.current?.abort();
    inFlight.current = null;
    previewInFlight.current?.abort();
    previewInFlight.current = null;
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);

  const preview = async () => {
    if (previewInFlight.current) return;
    const controller = new AbortController();
    previewInFlight.current = controller;
    setPreviewPending(true);
    setPreviewError('');
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = '';
    setPreviewUrl('');
    try {
      const outcome = await previewEpisodeVideo(episode, controller.signal);
      if (previewInFlight.current === controller) {
        previewUrlRef.current = outcome.url;
        setPreviewUrl(outcome.url);
        setPreviewIssues(outcome.skippedClips);
      } else {
        URL.revokeObjectURL(outcome.url);
      }
    } catch (error) {
      if (previewInFlight.current === controller && !controller.signal.aborted) {
        setPreviewError(error instanceof Error ? error.message : 'The voiced episode preview could not be prepared.');
      }
    } finally {
      if (previewInFlight.current === controller) {
        previewInFlight.current = null;
        setPreviewPending(false);
      }
    }
  };

  const download = async () => {
    if (previewUrl) {
      const anchor = document.createElement('a');
      const title = episode.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').trim() || 'untitled';
      anchor.href = previewUrl;
      anchor.download = `E${String(episode.number).padStart(2, '0')}-${title}.mp4`;
      anchor.click();
      setResult({ message: 'Voiced MP4 download started.', skippedClips: previewIssues });
      return;
    }
    if (inFlight.current) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setPending(true);
    setResult(null);
    try {
      const outcome = await downloadEpisodeVideo(episode, controller.signal);
      if (inFlight.current === controller) setResult(outcome);
    } finally {
      if (inFlight.current === controller) {
        inFlight.current = null;
        setPending(false);
      }
    }
  };

  return (
    <div style={{ marginTop: 10 }}>
      <button type="button" className="btn btn-quiet"
        data-testid={`button-preview-episode-${episode.id}`}
        aria-label={`Build and preview episode ${episode.number} with character voices`}
        disabled={previewPending || pending || !hasClips} onClick={preview}>
        {previewPending ? <LoaderCircle size={14} className="animate-spin" /> : <Download size={14} />}
        {previewPending ? 'Preparing voiced preview…' : previewUrl ? 'Rebuild voiced preview' : 'Build & preview voiced MP4'}
      </button>
      <button type="button" className="btn btn-quiet"
        data-testid={`button-download-episode-${episode.id}`}
        aria-label={`Download episode ${episode.number} MP4`}
        disabled={pending || previewPending || !hasClips} onClick={download}>
        {pending ? <LoaderCircle size={14} className="animate-spin" /> : <Download size={14} />}
        {pending ? 'Assembling MP4…' : previewUrl ? 'Download voiced MP4' : result?.busy || result?.retryable ? 'Retry MP4' : 'Download MP4'}
      </button>
      {previewPending ? (
        <button type="button" className="btn btn-quiet"
          data-testid={`button-cancel-episode-preview-${episode.id}`}
          aria-label={`Cancel episode ${episode.number} preview`}
          onClick={() => previewInFlight.current?.abort()}>
          Cancel preview
        </button>
      ) : null}
      {pending && (
        <button type="button" className="btn btn-quiet"
          data-testid={`button-cancel-episode-${episode.id}`}
          aria-label={`Cancel episode ${episode.number} export`}
          onClick={() => {
            inFlight.current?.abort();
            inFlight.current = null;
            setPending(false);
            setResult({ message: 'Export cancelled. You can try again.', skippedClips: [] });
          }}>
          Cancel export
        </button>
      )}
      <div role="status" aria-live="polite" data-testid={`status-episode-download-${episode.id}`}>
        <p className="row-caption" style={{ marginTop: 6 }}>
          {pending ? 'Assembling available clips in story order while preparing character voices. This may take a few minutes.'
            : previewPending ? 'Building the episode, generating character voices, and preparing an in-browser preview.'
              : (previewError || result?.message) ?? (hasClips
              ? 'Saved screenplay dialogue is spoken in distinct synthetic voices matched to each character’s personality. Unavailable clips may be skipped.'
              : 'No downloadable clips are available. Generate ready video clips with a video URL first.')}
        </p>
        {previewError ? <p className="field-error" role="alert">{previewError}</p> : null}
        {previewUrl ? (
          <video
            key={previewUrl}
            controls
            playsInline
            preload="metadata"
            src={previewUrl}
            aria-label={`Preview episode ${episode.number} with character voices`}
            data-testid={`video-episode-preview-${episode.id}`}
            style={{ width: '100%', maxHeight: 520, marginTop: 10, borderRadius: 12 }}
          />
        ) : null}
        {previewIssues.length ? (
          <ul className="row-caption" data-testid={`list-episode-preview-skipped-clips-${episode.id}`}>
            {previewIssues.map((clip, index) => (
              <li key={`${clip.clipId}-${index}`}>Clip {clip.clipId} ({clip.provider}): {clip.reason}</li>
            ))}
          </ul>
        ) : null}
        {result?.skippedClips.length ? (
          <ul className="row-caption" data-testid={`list-episode-skipped-clips-${episode.id}`}>
            {result.skippedClips.map((clip, index) => (
              <li key={`${clip.clipId}-${index}`}>Clip {clip.clipId} ({clip.provider}): {clip.reason}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
