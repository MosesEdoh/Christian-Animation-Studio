import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { getGetStudioBootstrapQueryKey, useGetStudioBootstrap, getListStudioExportsQueryKey, useCreateStudioExport, useGenerateShotClip } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useColors } from '@/hooks/useColors';
import { PrivateVideo } from '@/components/PrivateVideo';
import { VoicedEpisodePreview } from '@/components/VoicedEpisodePreview';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
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
  const query = useGetStudioBootstrap({ query: { queryKey: getGetStudioBootstrapQueryKey() } });
  const exports = useMovieExportHistory();
  const create = useCreateStudioExport();
  const generateClip = useGenerateShotClip();
  const button = { backgroundColor: colors.secondary, borderRadius: 12, padding: 13, marginBottom: 8 };
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
    setError('');
    try {
      for (const aspectRatio of ['16:9', '9:16'] as const) for (const quality of ['720p', '1080p'] as const) {
        await create.mutateAsync({ data: { episodeId, aspectRatio, quality } });
      }
      await cache.invalidateQueries({ queryKey: getListStudioExportsQueryKey() });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not build movie'); }
  }
  if (query.isLoading) return <ActivityIndicator color={colors.primary} />;
  if (query.isError || !query.data) return <View><Text style={{ color: colors.foreground }}>Studio unavailable.</Text><Pressable onPress={() => query.refetch()}><Text>Retry</Text></Pressable></View>;
  return <KeyboardAwareScrollViewCompat contentContainerStyle={{ padding: 20, paddingBottom: 115, gap: 16, backgroundColor: colors.background }}>
    <Text style={{ color: colors.coral, fontWeight: '700', fontSize: 11 }}>ANIMATION DESK</Text>
    <Text style={{ color: colors.foreground, fontFamily: 'Fraunces_600SemiBold', fontSize: 29 }}>Watch & download</Text>
    <Text style={{ color: colors.mutedForeground, lineHeight: 21 }}>Storyboard movies are silent review films with your complete scripts and references—not finished animation.</Text>
    <View style={{ padding: 16, gap: 12, borderRadius: 18, backgroundColor: colors.card }}>
      <Text style={{ color: colors.foreground, fontSize: 20, fontFamily: 'Fraunces_600SemiBold' }}>Generate a video clip</Text>
      <Text style={{ color: colors.mutedForeground, lineHeight: 20 }}>Google Gemini Omni creates a playable MP4. Each generation uses the studio’s Google API quota.</Text>
      <Text style={{ color: colors.foreground, fontWeight: '700' }}>Choose a storyboard shot</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {query.data.shots.map(shot => <Pressable
          key={shot.id}
          testID={`mobile-select-shot-${shot.id}`}
          accessibilityRole="button"
          accessibilityState={{ selected: activeShot?.id === shot.id }}
          onPress={() => setSelectedShot(shot.id)}
          style={{ ...button, marginBottom: 0, padding: 10, backgroundColor: activeShot?.id === shot.id ? colors.primary : colors.secondary }}
        >
          <Text style={{ color: activeShot?.id === shot.id ? colors.primaryForeground : colors.foreground }}>Shot {shot.number} · {shot.description}</Text>
        </Pressable>)}
      </View>
      <Text style={{ color: colors.foreground, fontWeight: '700' }}>Motion prompt</Text>
      <TextInput
        testID="mobile-video-prompt"
        accessibilityLabel="Motion prompt"
        multiline
        value={clipPrompt}
        onChangeText={setClipPrompt}
        placeholder="Describe the movement, texture, and feeling."
        placeholderTextColor={colors.mutedForeground}
        textAlignVertical="top"
        style={{ color: colors.foreground, backgroundColor: colors.background, borderColor: colors.border, borderWidth: 1, borderRadius: 12, padding: 12, minHeight: 96 }}
      />
      <Text style={{ color: colors.foreground, fontWeight: '700' }}>Orientation</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {(['16:9', '9:16'] as const).map(value => <Pressable key={value} testID={`mobile-aspect-${value}`} accessibilityRole="button" accessibilityState={{ selected: aspectRatio === value }} onPress={() => setAspectRatio(value)} style={{ ...button, flex: 1, marginBottom: 0, backgroundColor: aspectRatio === value ? colors.primary : colors.secondary }}><Text style={{ color: aspectRatio === value ? colors.primaryForeground : colors.foreground, textAlign: 'center' }}>{value === '16:9' ? 'Landscape' : 'Portrait'} · {value}</Text></Pressable>)}
      </View>
      <Text style={{ color: colors.foreground, fontWeight: '700' }}>Resolution</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {(['720p', '1080p'] as const).map(value => <Pressable key={value} testID={`mobile-resolution-${value}`} accessibilityRole="button" accessibilityState={{ selected: resolution === value }} onPress={() => setResolution(value)} style={{ ...button, flex: 1, marginBottom: 0, backgroundColor: resolution === value ? colors.primary : colors.secondary }}><Text style={{ color: resolution === value ? colors.primaryForeground : colors.foreground, textAlign: 'center' }}>{value}</Text></Pressable>)}
      </View>
      <Text style={{ color: colors.foreground, fontWeight: '700' }}>Clip length</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {[3, 5, 8, 10, 15].map(value => <Pressable key={value} testID={`mobile-duration-${value}`} accessibilityRole="button" accessibilityState={{ selected: durationSeconds === value }} onPress={() => setDurationSeconds(value)} style={{ ...button, marginBottom: 0, backgroundColor: durationSeconds === value ? colors.primary : colors.secondary }}><Text style={{ color: durationSeconds === value ? colors.primaryForeground : colors.foreground }}>{value} sec</Text></Pressable>)}
      </View>
      {activeShot?.referenceImageUrl ? <View style={{ gap: 8 }}>
        <Pressable
          testID="mobile-reference-safety"
          accessibilityRole="checkbox"
          accessibilityState={{ checked: useReference }}
          onPress={() => setUseReference(value => !value)}
          style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start', paddingVertical: 4 }}
        >
          <Text style={{ color: colors.primary, fontSize: 18 }}>{useReference ? '☑' : '☐'}</Text>
          <Text style={{ color: colors.foreground, flex: 1 }}>Use saved reference. I have permission to send it to Google, and it does not depict a child or minor.</Text>
        </Pressable>
        <Text style={{ color: colors.mutedForeground, lineHeight: 18 }}>Google restricts reference images depicting minors in the EEA, UK, and Switzerland. Leave this off to generate from text only.</Text>
      </View> : null}
      <Pressable
        testID="mobile-generate-video"
        accessibilityRole="button"
        onPress={generate}
        disabled={!activeShot || generateClip.isPending}
        style={{ ...button, backgroundColor: colors.primary, opacity: generateClip.isPending ? 0.7 : 1 }}
      >
        {generateClip.isPending ? <ActivityIndicator color={colors.primaryForeground} /> : <Text style={{ color: colors.primaryForeground, fontWeight: '700', textAlign: 'center' }}>Generate video clip</Text>}
      </Pressable>
    </View>
    {!!error && <Text accessibilityRole="alert" style={{ color: colors.destructive }}>{error}</Text>}
    <Pressable style={button} onPress={() => setEpisodeId(null)}><Text style={{ color: colors.foreground }}>{episodeId === null ? '✓ ' : ''}Entire series · one MP4</Text></Pressable>
    {query.data.episodes.map(episode => <Pressable key={episode.id} style={button} onPress={() => setEpisodeId(episode.id)}><Text style={{ color: colors.foreground }}>{episodeId === episode.id ? '✓ ' : ''}Episode {episode.number}: {episode.title}</Text></Pressable>)}
    {selectedEpisode ? <VoicedEpisodePreview episodeId={selectedEpisode.id} episodeTitle={`${selectedEpisode.number}: ${selectedEpisode.title}`} hasClips={hasReadyEpisodeClips} /> : null}
    <Pressable disabled={create.isPending} style={{ ...button, backgroundColor: colors.primary }} onPress={queue}><Text style={{ color: colors.primaryForeground, fontWeight: '700' }}>{create.isPending ? 'Queuing…' : 'Build MP4 · both orientations & resolutions'}</Text></Pressable>
    <Text style={{ color: colors.foreground, fontSize: 22, fontFamily: 'Fraunces_600SemiBold' }}>Saved movies</Text>
    <Pressable testID="mobile-refresh-movies" accessibilityRole="button" accessibilityState={{ disabled: exports.isFetching }} disabled={exports.isFetching} style={button} onPress={() => { if (!exports.isFetching) void exports.refetch(); }}><Text style={{ color: colors.foreground }}>{exports.isRefetching ? 'Refreshing movies…' : 'Refresh movies'}</Text></Pressable>
    {exports.isLoading && <ActivityIndicator testID="mobile-movies-loading" color={colors.primary} />}
    {exports.isError && !exports.isFetchNextPageError && <Text accessibilityRole="alert" style={{ color: colors.destructive }}>Could not refresh saved movies. Use Refresh movies to retry. Previously loaded movies are still available.</Text>}
    {!exports.isLoading && !exports.isError && exports.jobs.length === 0 && <Text style={{ color: colors.mutedForeground }}>No saved movies yet. Build a storyboard movie to see it here.</Text>}
    {selectedClip === null && movie?.url && <PrivateVideo key={movie.url} url={movie.url} label={`Storyboard #${movie.id} · ${movie.aspectRatio} · ${movie.quality}`} />}
    {selectedClip !== null && activeClip?.url && <PrivateVideo key={`clip-${selectedClip}`} url={activeClip.url} label={activeClip.provider} />}
    {exports.jobs.map(job => <Pressable key={job.id} testID={`mobile-select-movie-${job.id}`} accessibilityRole="button" accessibilityState={{ selected: selectedClip === null && movie?.id === job.id, disabled: job.status !== 'ready' || !job.url }} style={button} disabled={job.status !== 'ready' || !job.url} onPress={() => { setSelected(job.id); setSelectedClip(null); }}><Text style={{ color: colors.foreground }}>#{job.id} · {job.episodeId ? `Episode ${query.data?.episodes.find(episode => episode.id === job.episodeId)?.number}` : 'Series'} · {job.aspectRatio} · {job.quality} · {job.status} {job.status === 'rendering' ? `${job.progress}%` : ''}</Text>{job.error && <Text style={{ color: colors.destructive }}>{job.error}</Text>}</Pressable>)}
    {exports.isFetchNextPageError && <Text accessibilityRole="alert" style={{ color: colors.destructive }}>Could not load older movies. Your loaded movies are still available.</Text>}
    {exports.hasNextPage && <Pressable
      testID="mobile-load-older-movies"
      accessibilityRole="button"
      accessibilityState={{ disabled: exports.isFetching }}
      disabled={exports.isFetching}
      style={button}
      onPress={() => { if (!exports.isFetching) void exports.fetchNextPage({ cancelRefetch: false }); }}
    ><Text style={{ color: colors.foreground }}>{exports.isFetchingNextPage ? 'Loading older movies…' : exports.isFetchNextPageError ? 'Retry older movies' : 'Load older movies'}</Text></Pressable>}
    {exports.jobs.length > 0 && !exports.hasNextPage && !exports.isLoading && <Text testID="mobile-movies-end" style={{ color: colors.mutedForeground }}>All saved movies loaded.</Text>}
    <Text style={{ color: colors.foreground, fontSize: 22, fontFamily: 'Fraunces_600SemiBold' }}>Rendered clips</Text>
    {readyClips.length ? readyClips.map(clip => <Pressable key={clip.id} style={button} testID={`mobile-select-clip-${clip.id}`} onPress={() => setSelectedClip(clip.id)}><Text style={{ color: colors.foreground }}>Preview {clip.provider} · {clip.duration}</Text></Pressable>) : <Text style={{ color: colors.mutedForeground }}>No finished videos yet. Only real clips with playable video files appear here.</Text>}
  </KeyboardAwareScrollViewCompat>;
}
