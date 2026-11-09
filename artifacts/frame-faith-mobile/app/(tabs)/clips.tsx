import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { getGetStudioBootstrapQueryKey, useGetStudioBootstrap, useListStudioExports, getListStudioExportsQueryKey, useCreateStudioExport } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useColors } from '@/hooks/useColors';
import { PrivateVideo } from '@/components/PrivateVideo';

export default function ClipsScreen() {
  const colors = useColors();
  const cache = useQueryClient();
  const [episodeId, setEpisodeId] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [selectedClip, setSelectedClip] = useState<number | null>(null);
  const [error, setError] = useState('');
  const query = useGetStudioBootstrap({ query: { queryKey: getGetStudioBootstrapQueryKey() } });
  const exports = useListStudioExports({ query: { queryKey: getListStudioExportsQueryKey(), refetchInterval: 3000 } });
  const create = useCreateStudioExport();
  const button = { backgroundColor: colors.secondary, borderRadius: 12, padding: 13, marginBottom: 8 };
  const readyMovies = (exports.data ?? []).filter(job => job.status === 'ready' && job.url);
  const movie = readyMovies.find(job => job.id === selected) ?? readyMovies[0];
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
  const readyClips = query.data.clips.filter(clip => clip.status === 'ready' && clip.url);
  return <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 115, gap: 16, backgroundColor: colors.background }}>
    <Text style={{ color: colors.coral, fontWeight: '700', fontSize: 11 }}>ANIMATION DESK</Text>
    <Text style={{ color: colors.foreground, fontFamily: 'Fraunces_600SemiBold', fontSize: 29 }}>Watch & download</Text>
    <Text style={{ color: colors.mutedForeground, lineHeight: 21 }}>Storyboard movies are silent review films with your complete scripts and references—not finished animation.</Text>
    <Pressable style={button} onPress={() => setEpisodeId(null)}><Text style={{ color: colors.foreground }}>{episodeId === null ? '✓ ' : ''}Entire series · one MP4</Text></Pressable>
    {query.data.episodes.map(episode => <Pressable key={episode.id} style={button} onPress={() => setEpisodeId(episode.id)}><Text style={{ color: colors.foreground }}>{episodeId === episode.id ? '✓ ' : ''}Episode {episode.number}: {episode.title}</Text></Pressable>)}
    <Pressable disabled={create.isPending} style={{ ...button, backgroundColor: colors.primary }} onPress={queue}><Text style={{ color: colors.primaryForeground, fontWeight: '700' }}>{create.isPending ? 'Queuing…' : 'Build MP4 · both orientations & resolutions'}</Text></Pressable>
    {!!error && <Text style={{ color: colors.destructive }}>{error}</Text>}
    {exports.isError && <Pressable onPress={() => exports.refetch()}><Text style={{ color: colors.destructive }}>Could not load exports. Retry.</Text></Pressable>}
    {selectedClip === null && movie?.url && <PrivateVideo key={movie.url} url={movie.url} label={`Storyboard #${movie.id} · ${movie.aspectRatio} · ${movie.quality}`} />}
    {selectedClip !== null && readyClips.find(clip => clip.id === selectedClip)?.url && <PrivateVideo key={`clip-${selectedClip}`} url={readyClips.find(clip => clip.id === selectedClip)!.url!} label={readyClips.find(clip => clip.id === selectedClip)!.provider} />}
    {(exports.data ?? []).slice(0, 16).map(job => <Pressable key={job.id} style={button} disabled={job.status !== 'ready'} onPress={() => { setSelected(job.id); setSelectedClip(null); }}><Text style={{ color: colors.foreground }}>#{job.id} · {job.episodeId ? `Episode ${query.data?.episodes.find(episode => episode.id === job.episodeId)?.number}` : 'Series'} · {job.aspectRatio} · {job.quality} · {job.status} {job.status === 'rendering' ? `${job.progress}%` : ''}</Text>{job.error && <Text style={{ color: colors.destructive }}>{job.error}</Text>}</Pressable>)}
    <Text style={{ color: colors.foreground, fontSize: 22, fontFamily: 'Fraunces_600SemiBold' }}>Rendered clips</Text>
    {readyClips.length ? readyClips.map(clip => <Pressable key={clip.id} style={button} testID={`mobile-select-clip-${clip.id}`} onPress={() => setSelectedClip(clip.id)}><Text style={{ color: colors.foreground }}>Preview {clip.provider} · {clip.duration}</Text></Pressable>) : <Text style={{ color: colors.mutedForeground }}>No finished videos yet. Only real clips with playable video files appear here.</Text>}
  </ScrollView>;
}
