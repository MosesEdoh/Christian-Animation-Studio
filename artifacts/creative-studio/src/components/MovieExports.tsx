import { useRef, useState } from 'react';
import { getPreflightStudioExportQueryKey, preflightStudioExport, usePreflightStudioExport, useCancelStudioExport, useCreateStudioExport, useDeleteStudioExport, getListStudioExportsQueryKey, type Episode, type StudioExport } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { updateMovieExportCaches, useMovieExportHistory } from '../hooks/useMovieExportHistory';

type MovieFormat = { aspectRatio: '16:9' | '9:16'; quality: '720p' | '1080p' };
type MovieBatch = {
  episodeId: number | null;
  label: string;
  queued: MovieFormat[];
  remaining: MovieFormat[];
};
const formatLabel = (format: MovieFormat) => `${format.aspectRatio} · ${format.quality}`;

export function MovieExports({ episodes }: { episodes: Episode[] }) {
  const cache = useQueryClient();
  const [episodeId, setEpisodeId] = useState('series');
  const [aspectRatio, setAspectRatio] = useState<'16:9' | '9:16'>('16:9');
  const [quality, setQuality] = useState<'720p' | '1080p'>('720p');
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [queueing, setQueueing] = useState(false);
  const [batch, setBatch] = useState<MovieBatch | null>(null);
  const queueLock = useRef(false);
  const estimateParams = {
    ...(episodeId === 'series' ? {} : { episodeId: Number(episodeId) }),
    aspectRatio,
  };
  const estimate = usePreflightStudioExport(estimateParams, { query: {
    queryKey: getPreflightStudioExportQueryKey(estimateParams),
    staleTime: 0, refetchInterval: 30_000, retry: false,
  } });
  const jobs = useMovieExportHistory();
  const create = useCreateStudioExport();
  const cancel = useCancelStudioExport();
  const remove = useDeleteStudioExport();
  const [deletingId, setDeletingId] = useState<number | null>(null);
  async function deleteJob(job: StudioExport) {
    if (!window.confirm(`Permanently delete storyboard movie #${job.id} (${job.aspectRatio}, ${job.quality}) and its export history? This frees saved movie storage and cannot be undone. Your scripts and storyboard references will not be deleted.`)) return;
    setError('');
    setDeletingId(job.id);
    try {
      await remove.mutateAsync({ id: job.id });
      // Stop an older polling response from reintroducing the removed preview.
      await cache.cancelQueries({ queryKey: getListStudioExportsQueryKey() });
      updateMovieExportCaches(cache, previous => previous.filter(saved => saved.id !== job.id));
      setSelectedId(previous => previous === job.id ? null : previous);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not delete movie. Please try again.');
    } finally {
      setDeletingId(null);
      await cache.invalidateQueries({ queryKey: getListStudioExportsQueryKey() });
    }
  }
  const [cancellingId, setCancellingId] = useState<number | null>(null);
  async function cancelJob(id: number) {
    setError('');
    setCancellingId(id);
    try {
      const cancelled = await cancel.mutateAsync({ id });
      updateMovieExportCaches(cache, previous => previous.map(job => job.id === id ? cancelled : job));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not cancel movie.');
    } finally {
      setCancellingId(null);
      await cache.invalidateQueries({ queryKey: getListStudioExportsQueryKey() });
    }
  }
  const ready = jobs.jobs.filter(job => job.status === 'ready' && job.url);
  const selected = ready.find(job => job.id === selectedId) ?? ready[0];
  async function queue(all: boolean, retry?: { episodeId: number | null; aspectRatio: '16:9' | '9:16'; quality: '720p' | '1080p' }, resume?: MovieBatch) {
    if (queueLock.current) return;
    queueLock.current = true;
    setQueueing(true);
    setError('');
    const targetId = resume ? resume.episodeId : retry ? retry.episodeId : episodeId === 'series' ? null : Number(episodeId);
    const formats = resume ? resume.remaining : retry ? [{ aspectRatio: retry.aspectRatio, quality: retry.quality }] : all
      ? (['16:9', '9:16'] as const).flatMap(ratio => (['720p', '1080p'] as const).map(size => ({ aspectRatio: ratio, quality: size })))
      : [{ aspectRatio, quality }];
    let progress: MovieBatch | null = resume ?? (all ? {
      episodeId: targetId,
      label: targetId === null ? 'Entire series' : `Episode ${episodes.find(episode => episode.id === targetId)?.number ?? targetId}`,
      queued: [], remaining: formats,
    } : null);
    if (progress) setBatch(progress);
    let queuedCount = 0;
    try {
      // Refresh before queueing, including retries of a different selection.
      // Check every orientation before creating any of the batch's jobs.
      for (const ratio of new Set(formats.map(format => format.aspectRatio))) {
        const check = await preflightStudioExport({
          ...(targetId === null ? {} : { episodeId: targetId }), aspectRatio: ratio,
        });
        if (!check.canQueue) { setError(check.message); return; }
      }
      for (const format of formats) {
        await create.mutateAsync({ data: { episodeId: targetId, ...format } });
        queuedCount++;
        if (progress) {
          progress = { ...progress, queued: [...progress.queued, format], remaining: formats.slice(queuedCount) };
          setBatch(progress);
        }
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not queue movie.'); }
    finally {
      try {
        if (queuedCount > 0) await cache.invalidateQueries({ queryKey: getListStudioExportsQueryKey() });
      } catch {
        setError(previous => `${previous} Could not refresh movie exports. Please refresh the list.`.trim());
      } finally {
        queueLock.current = false;
        setQueueing(false);
      }
    }
  }
  return <section className="panel" style={{ marginTop: 24, padding: 24 }} data-testid="movie-exports">
    <span className="eyebrow">WATCHABLE EXPORTS</span>
    <h2>Storyboard movies</h2>
    <p className="row-caption">Complete saved scripts and storyboard references, assembled into a silent MP4 with readable dialogue cards. These are review animatics—not finished character animation or narrated episodes.</p>
    <div className="form-grid" style={{ marginTop: 16 }}>
      <div className="field"><label htmlFor="movie-episode">Episode or series</label><select id="movie-episode" value={episodeId} onChange={event => setEpisodeId(event.target.value)}><option value="series">Entire series · one MP4</option>{episodes.map(episode => <option key={episode.id} value={episode.id}>Episode {episode.number}: {episode.title}</option>)}</select></div>
      <div className="field"><label htmlFor="movie-ratio">Orientation</label><select id="movie-ratio" value={aspectRatio} onChange={event => setAspectRatio(event.target.value as '16:9' | '9:16')}><option>16:9</option><option>9:16</option></select></div>
      <div className="field"><label htmlFor="movie-quality">Resolution</label><select id="movie-quality" value={quality} onChange={event => setQuality(event.target.value as '720p' | '1080p')}><option>720p</option><option>1080p</option></select></div>
    </div>
    <div aria-live="polite" style={{ marginTop: 12 }} data-testid="movie-preflight">
      {estimate.isPending && <p>Checking saved scripts against movie limits…</p>}
      {estimate.isError && <p role="alert">Could not check movie limits. <button onClick={() => estimate.refetch()}>Check again</button></p>}
      {estimate.data && <p>{estimate.data.message}{estimate.data.canQueue && <> Estimated {estimate.data.cards?.toLocaleString()} / {estimate.data.cardLimit.toLocaleString()} cards · {Math.ceil((estimate.data.playbackSeconds ?? 0) / 60)} minutes / {estimate.data.playbackLimitSeconds / 3600} hours.</>}</p>}
      <p className="row-caption">Limits apply to each MP4, in either resolution. All four formats checks both orientations before queueing. Movies are never automatically split or shortened. This estimate uses saved scripts only; scripts and references can change, so rendering still checks card, playback, image, storage, and processing limits. A passing estimate does not guarantee a finished export.</p>
    </div>
    <div className="video-actions" style={{ marginTop: 12 }}>
      <button className="btn btn-primary" data-testid="create-movie" onClick={() => queue(false)} disabled={queueing || estimate.isPending || estimate.isError || !estimate.data?.canQueue}>Build storyboard MP4</button>
      <button className="btn btn-quiet" onClick={() => queue(true)} disabled={queueing || Boolean(batch?.remaining.length) || estimate.isPending || estimate.isError || !estimate.data?.canQueue}>Build all four formats</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {batch && <div aria-live="polite" data-testid="movie-batch-summary" style={{ marginTop: 12 }}>
      <p>Four-format batch · {batch.label}</p>
      <p data-testid="movie-batch-queued">Queued successfully: {batch.queued.length ? batch.queued.map(formatLabel).join(', ') : 'None'}.</p>
      <p data-testid="movie-batch-missing">Not queued: {batch.remaining.length ? batch.remaining.map(formatLabel).join(', ') : 'None — all four formats are queued'}.</p>
      {batch.remaining.length > 0 && <>
        <p>Queue only the missing formats for {batch.label}. Already queued jobs will not be repeated.</p>
        <button className="btn btn-primary" data-testid="queue-missing-movies" disabled={queueing} onClick={() => queue(false, undefined, batch)}>Queue missing formats</button>
      </>}
      <button className="btn btn-quiet" data-testid="dismiss-movie-batch" disabled={queueing} onClick={() => setBatch(null)}>Dismiss batch summary</button>
    </div>}
    {jobs.isPending && <p role="status">Loading movie exports…</p>}
    {jobs.isError && !jobs.isFetchNextPageError && <p role="alert">Could not load movie exports. <button onClick={() => jobs.refetch()}>Retry</button></p>}
    {selected?.url && <div style={{ marginTop: 20 }}>
      <label htmlFor="movie-preview-select">Saved movie preview</label>
      <select id="movie-preview-select" value={selected.id} onChange={event => setSelectedId(Number(event.target.value))}>{ready.map(job => <option key={job.id} value={job.id}>#{job.id} · {job.episodeId ? `Episode ${episodes.find(episode => episode.id === job.episodeId)?.number ?? job.episodeId}` : 'Entire series'} · {job.aspectRatio} · {job.quality}</option>)}</select>
      <video key={selected.id} controls playsInline preload="metadata" src={selected.url} style={{ width: '100%', maxHeight: 560, marginTop: 12 }} data-testid="movie-preview" />
      <a className="btn btn-primary" href={selected.url} download={`storyboard-${selected.id}-${selected.quality}.mp4`} data-testid="download-movie">Download MP4</a>
    </div>}
    <div style={{ marginTop: 16 }} aria-live="polite">
      {jobs.jobs.map(job => <p key={job.id} data-testid={`movie-job-${job.id}`}>
        #{job.id} · {job.episodeId ? `Episode ${episodes.find(episode => episode.id === job.episodeId)?.number ?? job.episodeId}` : 'Entire series'} · {job.aspectRatio} · {job.quality} — {job.status}{job.status === 'rendering' ? ` ${job.progress}%` : ''}
        {(job.status === 'queued' || job.status === 'rendering') && <> · <button disabled={cancellingId !== null} data-testid={`cancel-movie-${job.id}`} onClick={() => cancelJob(job.id)}>{cancellingId === job.id ? 'Cancelling…' : 'Cancel movie'}</button></>}
        {(job.status === 'failed' || job.status === 'cancelled') && <> · {job.status === 'cancelled' ? 'Cancelled. No movie was saved.' : job.error} <button disabled={queueing} onClick={() => queue(false, job)}>Build again</button></>}
        {(['ready', 'failed', 'cancelled'] as const).some(status => status === job.status) && <> · <button disabled={deletingId !== null} data-testid={`delete-movie-${job.id}`} onClick={() => deleteJob(job)}>{deletingId === job.id ? 'Deleting…' : 'Delete movie'}</button></>}
      </p>)}
    </div>
    {jobs.isFetchNextPageError && <p role="alert">Could not load older movies. Your loaded movies are still available. Try loading more again.</p>}
    {jobs.hasNextPage && <button className="btn btn-quiet" disabled={jobs.isFetching} onClick={() => jobs.fetchNextPage()} data-testid="load-more-movies">{jobs.isFetchingNextPage ? 'Loading older movies…' : jobs.isFetchNextPageError ? 'Retry loading older movies' : 'Load more movies'}</button>}
  </section>;
}
