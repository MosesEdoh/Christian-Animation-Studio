import { useEffect, useRef, useState } from 'react';
import { randomUUID } from 'expo-crypto';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { getGetStudioBootstrapQueryKey, useGetStudioBootstrap, getListStudioExportsQueryKey, useCreateStudioExport, useGenerateShotClip, type StudioExportInput } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useColors } from '@/hooks/useColors';
import { PrivateVideo } from '@/components/PrivateVideo';
import { VoicedEpisodePreview } from '@/components/VoicedEpisodePreview';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { Badge, Button, Card, Chip, EmptyState, FieldLabel, Notice, ProgressBar, ScreenHeader, SectionHeader, StateScreen, fonts } from '@/components/ui';
import { useMovieExportHistory } from '@/hooks/useMovieExportHistory';

export default function ClipsScreen() {
  const colors = useColors();
  const cache = useQueryClient();
  const [episodeId, setEpisodeId] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [selectedClip, setSelectedClip] = useState<number | null>(null);
  const [selectedShot, setSelectedShot] = useState<number | null>(null);
  const [clipPrompt, setClipPrompt] = useState('');
  const [aspectRatio, setAspectRatio] = useState<'16:9' | '9:16'>('16:9');
  const [resolution, setResolution] = useState<'720p' | '1080p'>('720p');
  const [durationSeconds, setDurationSeconds] = useState(5);
  const [useReference, setUseReference] = useState(false);
  const [error, setError] = useState('');
  const [queuing, setQueuing] = useState(false);
  const queueRunning = useRef(false);
  // Keep each scope's unfinished batch, including its unconfirmed request.
  // Confirmed formats are removed so a partial retry cannot rebuild them.
  const unfinishedBatches = useRef(new Map<number | null, StudioExportInput[]>());
  const query = useGetStudioBootstrap({ query: { queryKey: getGetStudioBootstrapQueryKey() } });
  const exports = useMovieExportHistory();
  const create = useCreateStudioExport();
  const generateClip = useGenerateShotClip();
  const readyMovies = exports.jobs.filter(job => job.status === 'ready' && job.url);
  const movie = readyMovies.find(job => job.id === selected) ?? readyMovies[0];
  const activeShot = query.data?.shots.find(shot => shot.id === selectedShot) ?? query.data?.shots[0];
  const readyClips = (query.data?.clips ?? []).filter(clip => clip.status === 'ready' && clip.url);
  const activeClip = readyClips.find(clip => clip.id === selectedClip);
  const selectedEpisode = query.data?.episodes.find(episode => episode.id === episodeId);
  const episodeSceneIds = new Set(query.data?.scenes.filter(scene => scene.episodeId === episodeId).map(scene => scene.id) ?? []);
  const episodeShotIds = new Set(query.data?.shots.filter(shot => episodeSceneIds.has(shot.sceneId)).map(shot => shot.id) ?? []);
  const hasReadyEpisodeClips = readyClips.some(clip => episodeShotIds.has(clip.shotId));
  useEffect(() => {
    if (activeShot) {
      setClipPrompt(activeShot.description);
      setUseReference(false);
    }
  }, [activeShot?.id, activeShot?.description, activeShot?.referenceImageUrl]);
  async function generate() {
    if (!activeShot) return;
    setError('');
    try {
      const clip = await generateClip.mutateAsync({
        data: {
          shotId: activeShot.id,
          prompt: clipPrompt.trim() || activeShot.description,
          provider: 'google-omni',
          aspectRatio,
          resolution,
          durationSeconds,
          referenceImageUrl: useReference ? activeShot.referenceImageUrl : null,
          referenceSafetyConfirmed: useReference,
        },
      });
      setSelectedClip(clip.id);
      await cache.invalidateQueries({ queryKey: getGetStudioBootstrapQueryKey() });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Google could not generate this clip.');
    }
  }
  async function queue() {
    if (queueRunning.current) return;
    queueRunning.current = true;
    setQueuing(true);
    setError('');
    try {
      let remaining = unfinishedBatches.current.get(episodeId);
      if (!remaining) {
        remaining = (['16:9', '9:16'] as const).flatMap(aspectRatio =>
          (['720p', '1080p'] as const).map(quality => ({
            episodeId, aspectRatio, quality, requestId: randomUUID(),
          })));
        unfinishedBatches.current.set(episodeId, remaining);
      }
      while (remaining.length) {
        await create.mutateAsync({ data: remaining[0] });
        remaining.shift();
      }
      // A subsequent press is a deliberate rebuild, with fresh IDs.
      unfinishedBatches.current.delete(episodeId);
    } catch (cause) {
      setError(`${cause instanceof Error ? cause.message : 'Could not build movie'}. Retry the build to safely continue the unfinished formats.`);
    } finally {
      queueRunning.current = false;
      setQueuing(false);
      // Partial successes should appear even if a later response was lost.
      void cache.invalidateQueries({ queryKey: getListStudioExportsQueryKey() });
    }
  }
  if (query.isLoading) return <StateScreen loading message="Loading the animation desk…" />;
  if (query.isError || !query.data) {
    return (
      <StateScreen title="Studio unavailable" message="We couldn’t load your shots and clips. Check your connection and try again.">
        <Button label="Retry" onPress={() => void query.refetch()} />
      </StateScreen>
    );
  }
  const episodeLabel = (id: number | null) => {
    if (id === null) return 'Series';
    const episode = query.data?.episodes.find(item => item.id === id);
    return episode ? `Episode ${episode.number}` : 'Episode';
  };
  const statusTone = (status: string) => status === 'ready' ? 'success' : status === 'failed' ? 'danger' : 'warning';
  return <KeyboardAwareScrollViewCompat screen>
    <ScreenHeader
      kicker="ANIMATION DESK"
      title="Watch & download"
      subtitle="Generate clips from storyboard shots, then build silent storyboard movies for review. Storyboard movies show your scripts and references—they’re not finished animation."
    />

    <Card>
      <SectionTitle step="1" title="Generate a video clip" caption="Google Gemini Omni creates a playable MP4. Each generation uses the studio’s Google API quota." />
      <FieldLabel hint={activeShot ? `Shot ${activeShot.number}: ${activeShot.description}` : undefined}>Choose a storyboard shot</FieldLabel>
      {query.data.shots.length === 0 ? (
        <EmptyState title="No storyboard shots yet" body="Add shots in the web studio's storyboard, then generate clips here." />
      ) : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {query.data.shots.map(shot => <Chip
            key={shot.id}
            testID={`mobile-select-shot-${shot.id}`}
            label={`Shot ${shot.number}`}
            accessibilityLabel={`Shot ${shot.number} · ${shot.description}`}
            selected={activeShot?.id === shot.id}
            onPress={() => setSelectedShot(shot.id)}
          />)}
        </View>
      )}
      <FieldLabel hint="Describe the movement, texture, and feeling.">Motion prompt</FieldLabel>
      <TextInput
        testID="mobile-video-prompt"
        accessibilityLabel="Motion prompt"
        multiline
        value={clipPrompt}
        onChangeText={setClipPrompt}
        placeholder="Describe the movement, texture, and feeling."
        placeholderTextColor={colors.mutedForeground}
        textAlignVertical="top"
        style={{ color: colors.foreground, backgroundColor: colors.background, borderColor: colors.border, borderWidth: 1, borderRadius: 12, padding: 12, minHeight: 96, fontFamily: fonts.regular, fontSize: 15, lineHeight: 22 }}
      />
      <FieldLabel>Orientation</FieldLabel>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {(['16:9', '9:16'] as const).map(value => <Chip key={value} grow testID={`mobile-aspect-${value}`} selected={aspectRatio === value} onPress={() => setAspectRatio(value)} label={`${value === '16:9' ? 'Landscape' : 'Portrait'} · ${value}`} />)}
      </View>
      <FieldLabel>Resolution</FieldLabel>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {(['720p', '1080p'] as const).map(value => <Chip key={value} grow testID={`mobile-resolution-${value}`} selected={resolution === value} onPress={() => setResolution(value)} label={value} />)}
      </View>
      <FieldLabel>Clip length</FieldLabel>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {[3, 5, 8, 10, 15].map(value => <Chip key={value} testID={`mobile-duration-${value}`} selected={durationSeconds === value} onPress={() => setDurationSeconds(value)} label={`${value} sec`} />)}
      </View>
      {activeShot?.referenceImageUrl ? <View style={{ gap: 8 }}>
        <Pressable
          testID="mobile-reference-safety"
          accessibilityRole="checkbox"
          accessibilityState={{ checked: useReference }}
          onPress={() => setUseReference(value => !value)}
          style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start', paddingVertical: 4 }}
        >
          <View style={{ width: 22, height: 22, borderWidth: 1, borderRadius: 6, marginTop: 1, alignItems: 'center', justifyContent: 'center', borderColor: useReference ? colors.teal : colors.border, backgroundColor: useReference ? colors.teal : 'transparent' }}>
            {useReference ? <Text style={{ color: colors.card, fontFamily: fonts.bold }}>✓</Text> : null}
          </View>
          <Text style={{ color: colors.foreground, flex: 1, fontFamily: fonts.regular, lineHeight: 20 }}>Use saved reference. I have permission to send it to Google, and it does not depict a child or minor.</Text>
        </Pressable>
        <Text style={{ color: colors.mutedForeground, lineHeight: 18, fontFamily: fonts.regular, fontSize: 12 }}>Google restricts reference images depicting minors in the EEA, UK, and Switzerland. Leave this off to generate from text only.</Text>
      </View> : null}
      <Button
        testID="mobile-generate-video"
        onPress={generate}
        disabled={!activeShot}
        loading={generateClip.isPending}
        label={generateClip.isPending ? 'Generating clip…' : 'Generate video clip'}
      />
    </Card>

    {!!error && <Notice tone="error">{error}</Notice>}

    <Card>
      <SectionTitle step="2" title="Build a storyboard movie" caption="Choose the whole series or one episode. We build both orientations at 720p and 1080p." />
      <View style={{ gap: 8 }}>
        <Chip label="Entire series · one MP4" selected={episodeId === null} onPress={() => setEpisodeId(null)} />
        {query.data.episodes.map(episode => <Chip key={episode.id} label={`Episode ${episode.number}: ${episode.title}`} selected={episodeId === episode.id} onPress={() => setEpisodeId(episode.id)} />)}
      </View>
      {selectedEpisode ? <VoicedEpisodePreview episodeId={selectedEpisode.id} episodeTitle={`${selectedEpisode.number}: ${selectedEpisode.title}`} hasClips={hasReadyEpisodeClips} /> : null}
      <Button
        testID="mobile-build-movies"
        disabled={queuing}
        onPress={queue}
        label={queuing ? 'Queuing…' : unfinishedBatches.current.has(episodeId) ? 'Retry MP4 build · unfinished formats' : 'Build MP4 · both orientations & resolutions'}
      />
    </Card>

    <SectionHeader
      title="Saved movies"
      right={<Button compact variant="secondary" testID="mobile-refresh-movies" disabled={exports.isFetching} onPress={() => { if (!exports.isFetching) void exports.refetch(); }} label={exports.isRefetching ? 'Refreshing movies…' : 'Refresh movies'} />}
    />
    {exports.isLoading && <ActivityIndicator testID="mobile-movies-loading" color={colors.teal} />}
    {exports.isError && !exports.isFetchNextPageError && <Notice tone="error">Could not refresh saved movies. Use Refresh movies to retry. Previously loaded movies are still available.</Notice>}
    {!exports.isLoading && !exports.isError && exports.jobs.length === 0 && <EmptyState title="No saved movies yet" body="Build a storyboard movie to see it here." />}
    {selectedClip === null && movie?.url && <PrivateVideo key={movie.url} url={movie.url} label={`Storyboard #${movie.id} · ${movie.aspectRatio} · ${movie.quality}`} />}
    {selectedClip !== null && activeClip?.url && <PrivateVideo key={`clip-${selectedClip}`} url={activeClip.url} label={activeClip.provider} />}
    {exports.jobs.map(job => {
      const isSelected = selectedClip === null && movie?.id === job.id;
      const playable = job.status === 'ready' && !!job.url;
      return <Pressable
        key={job.id}
        testID={`mobile-select-movie-${job.id}`}
        accessibilityRole="button"
        accessibilityState={{ selected: isSelected, disabled: !playable }}
        accessibilityHint={playable ? 'Plays this movie above' : undefined}
        disabled={!playable}
        onPress={() => { setSelected(job.id); setSelectedClip(null); }}
        style={{ borderWidth: 1, borderRadius: 14, padding: 14, gap: 6, backgroundColor: colors.card, borderColor: isSelected ? colors.teal : colors.border }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <Text style={{ color: colors.foreground, fontFamily: fonts.bold, fontSize: 15, flexShrink: 1 }}>#{job.id} · {episodeLabel(job.episodeId)}</Text>
          <Badge label={job.status === 'rendering' ? `${job.status} ${job.progress}%` : job.status} tone={statusTone(job.status)} />
        </View>
        <Text style={{ color: colors.mutedForeground, fontFamily: fonts.medium, fontSize: 13 }}>{job.aspectRatio === '9:16' ? 'Portrait' : 'Landscape'} · {job.aspectRatio} · {job.quality}{isSelected ? ' · Now playing' : ''}</Text>
        {job.status === 'rendering' ? <ProgressBar value={job.progress} /> : null}
        {job.error && <Text style={{ color: colors.destructive, fontFamily: fonts.regular, fontSize: 13 }}>{job.error}</Text>}
      </Pressable>;
    })}
    {exports.isFetchNextPageError && <Notice tone="error">Could not load older movies. Your loaded movies are still available.</Notice>}
    {exports.hasNextPage && <Button
      variant="secondary"
      testID="mobile-load-older-movies"
      disabled={exports.isFetching}
      onPress={() => { if (!exports.isFetching) void exports.fetchNextPage({ cancelRefetch: false }); }}
      label={exports.isFetchingNextPage ? 'Loading older movies…' : exports.isFetchNextPageError ? 'Retry older movies' : 'Load older movies'}
    />}
    {exports.jobs.length > 0 && !exports.hasNextPage && !exports.isLoading && <Text testID="mobile-movies-end" style={{ color: colors.mutedForeground, textAlign: 'center', fontFamily: fonts.medium, fontSize: 12 }}>All saved movies loaded.</Text>}

    <SectionHeader title="Rendered clips" caption="Tap a clip to preview it in the player above." />
    {readyClips.length ? readyClips.map(clip => <Pressable
      key={clip.id}
      testID={`mobile-select-clip-${clip.id}`}
      accessibilityRole="button"
      accessibilityState={{ selected: selectedClip === clip.id }}
      onPress={() => setSelectedClip(clip.id)}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderRadius: 14, padding: 14, backgroundColor: colors.card, borderColor: selectedClip === clip.id ? colors.teal : colors.border }}
    >
      <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: colors.accentForeground, fontFamily: fonts.bold }}>▶</Text>
      </View>
      <Text style={{ color: colors.foreground, fontFamily: fonts.semibold, flex: 1 }}>Preview {clip.provider} · {clip.duration}</Text>
    </Pressable>) : <EmptyState title="No finished videos yet" body="Only real clips with playable video files appear here." />}
  </KeyboardAwareScrollViewCompat>;
}

function SectionTitle({ step, title, caption }: { step: string; title: string; caption?: string }) {
  const colors = useColors();
  return (
    <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
      <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center', marginTop: 2 }}>
        <Text style={{ fontFamily: fonts.bold, fontSize: 13, color: colors.accentForeground }}>{step}</Text>
      </View>
      <View style={{ flex: 1, gap: 4 }}>
        <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 20, fontFamily: fonts.serif }}>{title}</Text>
        {caption ? <Text style={{ color: colors.mutedForeground, lineHeight: 20, fontFamily: fonts.regular, fontSize: 13 }}>{caption}</Text> : null}
      </View>
    </View>
  );
}
