import { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { getGetStudioBootstrapQueryKey, useGetStudioBootstrap } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { Badge, Button, Chip, EmptyState, ScreenHeader, StateScreen, fonts } from '@/components/ui';

const sceneTone = { draft: 'neutral', review: 'warning', locked: 'success' } as const;

export default function StoriesScreen() {
  const colors = useColors();
  const [openScene, setOpenScene] = useState<number | null>(null);
  const [episodeFilter, setEpisodeFilter] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const query = useGetStudioBootstrap({ query: { queryKey: getGetStudioBootstrapQueryKey() } });

  async function refresh() {
    setRefreshing(true);
    try { await query.refetch(); } finally { setRefreshing(false); }
  }

  if (query.isLoading) return <StateScreen loading message="Opening the script room…" />;
  if (query.isError || !query.data) {
    return (
      <StateScreen title="Stories are unavailable" message="We couldn’t load scripts and storyboards. Check your connection and try again.">
        <Button label="Try again" loading={query.isFetching} onPress={() => void query.refetch()} />
      </StateScreen>
    );
  }
  const { episodes, scenes, shots } = query.data;
  const sortedEpisodes = [...episodes].sort((a, b) => a.number - b.number);
  const visibleEpisodes = episodeFilter === null ? sortedEpisodes : sortedEpisodes.filter(episode => episode.id === episodeFilter);

  return (
    <KeyboardAwareScrollViewCompat
      screen
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={colors.teal} />}
    >
      <ScreenHeader kicker="STORY DEPARTMENT" title="Scripts & boards" subtitle="Read each scene and its storyboard frames. Tap a scene to open it." />

      {sortedEpisodes.length > 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 2 }}>
          <Chip label="All episodes" selected={episodeFilter === null} onPress={() => setEpisodeFilter(null)} />
          {sortedEpisodes.map(episode => (
            <Chip key={episode.id} label={`Ep ${episode.number}`} accessibilityLabel={`Episode ${episode.number}: ${episode.title}`} selected={episodeFilter === episode.id} onPress={() => setEpisodeFilter(episode.id)} />
          ))}
        </ScrollView>
      ) : null}

      {visibleEpisodes.length === 0 ? (
        <EmptyState title="No stories yet" body="Write your first scene in the web studio and it will appear here to read on the go." />
      ) : null}

      {visibleEpisodes.map((episode) => {
        const episodeScenes = scenes.filter(scene => scene.episodeId === episode.id).sort((a, b) => a.number - b.number);
        return (
          <View key={episode.id} style={{ gap: 10, marginTop: 8 }}>
            <View style={{ gap: 2 }}>
              <Text style={{ fontFamily: fonts.bold, fontSize: 11, letterSpacing: 1, color: colors.coral }}>EPISODE {String(episode.number).padStart(2, '0')}</Text>
              <Text accessibilityRole="header" style={{ fontFamily: fonts.serif, fontSize: 22, color: colors.foreground }}>{episode.title}</Text>
            </View>
            {episodeScenes.length === 0 ? (
              <EmptyState title="No scenes in this episode" body="Scenes added in the web studio will show up here." />
            ) : episodeScenes.map(scene => {
              const sceneShots = shots.filter(shot => shot.sceneId === scene.id).sort((a, b) => a.number - b.number);
              const expanded = openScene === scene.id;
              return (
                <Pressable
                  key={scene.id}
                  accessibilityRole="button"
                  accessibilityState={{ expanded }}
                  accessibilityHint={expanded ? 'Collapses the scene' : 'Opens the full scene and storyboard'}
                  onPress={() => setOpenScene(expanded ? null : scene.id)}
                  style={({ pressed }) => ({ borderWidth: 1, borderRadius: 18, padding: 16, gap: 8, backgroundColor: colors.card, borderColor: expanded ? colors.teal : colors.border, opacity: pressed ? 0.92 : 1 })}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <Text style={{ fontFamily: fonts.bold, fontSize: 10, letterSpacing: 0.8, color: colors.teal, flexShrink: 1 }}>
                      SCENE {String(scene.number).padStart(2, '0')} · {scene.duration} · {sceneShots.length} FRAME{sceneShots.length === 1 ? '' : 'S'}
                    </Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <Badge label={scene.status} tone={sceneTone[scene.status] ?? 'neutral'} />
                      <Feather name={expanded ? 'chevron-up' : 'chevron-down'} size={18} color={colors.mutedForeground} />
                    </View>
                  </View>
                  <Text style={{ fontFamily: fonts.bold, fontSize: 16, color: colors.foreground }}>{scene.heading}</Text>
                  {scene.synopsis ? <Text style={{ fontFamily: fonts.regular, fontSize: 14, lineHeight: 21, color: colors.mutedForeground }}>{scene.synopsis}</Text> : null}
                  {expanded ? (
                    <View style={{ gap: 10, marginTop: 4 }}>
                      <View style={{ padding: 14, borderRadius: 12, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border }}>
                        <Text selectable style={{ fontFamily: fonts.regular, fontSize: 15, lineHeight: 24, color: colors.foreground }}>
                          {scene.content || 'This scene has no script yet.'}
                        </Text>
                      </View>
                      <Text style={{ fontFamily: fonts.bold, fontSize: 11, letterSpacing: 1.2, color: colors.coral }}>STORYBOARD</Text>
                      {sceneShots.length === 0 ? (
                        <Text style={{ fontFamily: fonts.regular, fontSize: 13, color: colors.mutedForeground }}>No storyboard frames yet.</Text>
                      ) : sceneShots.map(shot => (
                        <View key={shot.id} style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
                          <View style={{ width: 28, height: 28, borderRadius: 8, backgroundColor: colors.secondary, alignItems: 'center', justifyContent: 'center' }}>
                            <Text style={{ fontFamily: fonts.bold, fontSize: 12, color: colors.foreground }}>{shot.number}</Text>
                          </View>
                          <View style={{ flex: 1, gap: 2 }}>
                            <Text style={{ fontFamily: fonts.regular, fontSize: 14, lineHeight: 21, color: colors.foreground }}>{shot.description}</Text>
                            {[shot.shotType, shot.movement, shot.angle].some(Boolean) ? (
                              <Text style={{ fontFamily: fonts.medium, fontSize: 12, color: colors.mutedForeground }}>{[shot.shotType, shot.movement, shot.angle].filter(Boolean).join(' · ')}</Text>
                            ) : null}
                          </View>
                        </View>
                      ))}
                    </View>
                  ) : (
                    <Text style={{ fontFamily: fonts.semibold, fontSize: 12, color: colors.teal }}>Tap to read scene</Text>
                  )}
                </Pressable>
              );
            })}
          </View>
        );
      })}
    </KeyboardAwareScrollViewCompat>
  );
}
