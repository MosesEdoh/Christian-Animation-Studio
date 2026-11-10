import { useEffect, useRef, useState } from 'react';
import { Download, LoaderCircle } from 'lucide-react';
import type { Episode } from '@workspace/api-client-react';
import { downloadEpisodeVideo, type EpisodeDownloadResult } from '../lib/episodeDownload';

export function EpisodeDownload({ episode, hasClips }: { episode: Episode; hasClips: boolean }) {
  const inFlight = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<EpisodeDownloadResult | null>(null);

  useEffect(() => () => {
    inFlight.current?.abort();
    inFlight.current = null;
  }, []);

  const download = async () => {
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
        data-testid={`button-download-episode-${episode.id}`}
        aria-label={`Download episode ${episode.number} MP4`}
        disabled={pending || !hasClips} onClick={download}>
        {pending ? <LoaderCircle size={14} className="animate-spin" /> : <Download size={14} />}
        {pending ? 'Assembling MP4…' : result?.busy || result?.retryable ? 'Retry MP4' : 'Download MP4'}
      </button>
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
          {pending ? 'Assembling available clips in story order. This may take a few minutes.'
            : result?.message ?? (hasClips
              ? 'Assembles ready clips only, without the series ZIP. Unavailable clips may be skipped.'
              : 'No downloadable clips are available. Generate ready video clips with a video URL first.')}
        </p>
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
