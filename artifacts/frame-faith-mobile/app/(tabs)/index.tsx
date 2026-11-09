import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useGetStudioBootstrap, getGetStudioBootstrapQueryKey } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';

export default function HomeScreen() {
  const colors = useColors();
  const query = useGetStudioBootstrap({ query: { queryKey: getGetStudioBootstrapQueryKey() } });
  if (query.isLoading) return <View style={[styles.center, { backgroundColor: colors.background }]}><ActivityIndicator color={colors.primary} /><Text style={{ color: colors.foreground }}>Loading your studio…</Text></View>;
  if (query.isError || !query.data) return <View style={[styles.center, { backgroundColor: colors.background }]}><Text style={{ color: colors.foreground }}>Could not load the studio.</Text><Pressable onPress={() => query.refetch()}><Text style={{ color: colors.teal, marginTop: 12 }}>Try again</Text></Pressable></View>;
  const { project, episodes, scenes, shots } = query.data;
  return (
    <ScrollView contentContainerStyle={[styles.container, { backgroundColor: colors.background }]}>
      <Text style={[styles.kicker, { color: colors.teal }]}>FRAME & FAITH · MOBILE</Text>
      <Text style={[styles.title, { color: colors.foreground }]}>{project.title}</Text>
      <Text style={[styles.text, { color: colors.mutedForeground }]}>{project.logline}</Text>
      <View style={[styles.hero, { backgroundColor: colors.foreground }]}>
        <Text style={[styles.heroLabel, { color: colors.accent }]}>YOUR SEASON</Text>
        <Text style={[styles.heroTitle, { color: colors.card }]}>{episodes.length} episodes in progress</Text>
        <Text style={[styles.heroText, { color: colors.card }]}>{scenes.length} scenes · {shots.length} storyboard frames</Text>
      </View>
      <Text style={[styles.section, { color: colors.foreground }]}>The season</Text>
      {episodes.map((episode) => {
        const episodeScenes = scenes.filter((scene) => scene.episodeId === episode.id);
        return <View key={episode.id} style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.episodeNo, { color: colors.coral }]}>EPISODE {String(episode.number).padStart(2, '0')} · {episode.duration}</Text>
          <Text style={[styles.cardTitle, { color: colors.foreground }]}>{episode.title}</Text>
          <Text style={[styles.text, { color: colors.mutedForeground }]}>{episode.summary}</Text>
          <Text style={[styles.meta, { color: colors.teal }]}>{episodeScenes.length} scenes · {episode.progress}% complete</Text>
        </View>;
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 22,
    paddingTop: 24,
    paddingBottom: 110,
    gap: 12,
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  kicker: { fontSize: 11, fontWeight: '700', letterSpacing: 1.5, marginTop: 12 },
  title: { fontFamily: 'Fraunces_600SemiBold', fontSize: 34, lineHeight: 40 },
  text: { fontFamily: 'Manrope_400Regular', fontSize: 15, lineHeight: 22 },
  hero: { borderRadius: 22, padding: 22, marginTop: 12 },
  heroLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 1.4 },
  heroTitle: { fontFamily: 'Fraunces_600SemiBold', fontSize: 21, marginTop: 8 },
  heroText: { fontSize: 13, marginTop: 6, opacity: 0.8 },
  section: { fontSize: 21, fontWeight: '700', marginTop: 18, marginBottom: 2 },
  card: { borderWidth: 1, borderRadius: 18, padding: 17, gap: 7 },
  episodeNo: { fontSize: 10, fontWeight: '700', letterSpacing: 1 },
  cardTitle: { fontSize: 19, fontWeight: '700' },
  meta: { fontSize: 12, fontWeight: '600', marginTop: 4 },
});
