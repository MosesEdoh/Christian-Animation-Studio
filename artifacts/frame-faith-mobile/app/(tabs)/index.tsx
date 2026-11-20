import { useState } from 'react';
import { Pressable, RefreshControl, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { useAuth, useUser } from '@clerk/expo';
import { useGetStudioBootstrap, getGetStudioBootstrapQueryKey } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { useTrustedDevice } from '@/components/TrustedDeviceGate';
import { Badge, BrandMark, Button, Card, EmptyState, Notice, ProgressBar, SectionHeader, StateScreen, fonts, inkText } from '@/components/ui';
import { confirmAction } from '@/lib/confirm';

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function initials(name: string) {
  const parts = name.split(/[\s@._-]+/).filter(Boolean);
  return (parts.slice(0, 2).map(part => part[0]).join('') || 'FF').toUpperCase();
}

export default function HomeScreen() {
  const colors = useColors();
  const auth = useAuth();
  const { user } = useUser();
  const device = useTrustedDevice();
  const [refreshing, setRefreshing] = useState(false);
  const query = useGetStudioBootstrap({ query: { queryKey: getGetStudioBootstrapQueryKey() } });
  const email = user?.primaryEmailAddress?.emailAddress ?? '';
  const firstName = user?.firstName || (email ? email.split('@')[0] : '');

  async function refresh() {
    setRefreshing(true);
    try { await query.refetch(); } finally { setRefreshing(false); }
  }

  async function signOut() {
    const confirmed = await confirmAction({
      title: 'Sign out?',
      message: 'You can sign back in at any time. This device stays trusted.',
      confirmLabel: 'Sign out',
    });
    if (confirmed) await auth.signOut();
  }

  if (query.isLoading) return <StateScreen loading message="Loading your studio…" />;
  if (query.isError || !query.data) {
    return (
      <StateScreen title="We couldn’t load the studio" message="Check your connection and make sure you’re using a verified email on a trusted device.">
        <Button label="Try again" loading={query.isFetching} onPress={() => void query.refetch()} />
        <Button variant="ghost" label="Sign out" testID="mobile-logout" onPress={() => void auth.signOut()} />
      </StateScreen>
    );
  }

  const { project, episodes, scenes, shots, clips } = query.data;
  const sortedEpisodes = [...episodes].sort((a, b) => a.number - b.number);
  const readyClips = clips.filter(clip => clip.status === 'ready' && clip.url).length;
  const seasonProgress = episodes.length ? episodes.reduce((sum, episode) => sum + episode.progress, 0) / episodes.length : 0;
  const current = episodes.find(episode => episode.id === project.activeEpisodeId)
    ?? sortedEpisodes.find(episode => episode.progress < 100)
    ?? sortedEpisodes[0];
  const stats = [
    { label: 'Episodes', value: episodes.length },
    { label: 'Scenes', value: scenes.length },
    { label: 'Frames', value: shots.length },
    { label: 'Clips', value: readyClips },
  ];

  return (
    <KeyboardAwareScrollViewCompat
      screen
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={colors.teal} />}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <BrandMark />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Account${email ? `, signed in as ${email}` : ''}. Opens sign out.`}
          onPress={() => void signOut()}
          hitSlop={8}
          style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: colors.secondary, alignItems: 'center', justifyContent: 'center' }}
        >
          <Text style={{ fontFamily: fonts.bold, color: colors.foreground }}>{initials(firstName || email)}</Text>
        </Pressable>
      </View>

      <View style={{ gap: 4, marginTop: 6 }}>
        <Text style={{ fontFamily: fonts.medium, fontSize: 15, color: colors.mutedForeground }}>{greeting()}, {firstName || 'creator'}</Text>
        <Text accessibilityRole="header" style={{ fontFamily: fonts.serif, fontSize: 32, lineHeight: 38, color: colors.foreground }}>{project.title}</Text>
        {project.logline ? <Text style={{ fontFamily: fonts.regular, fontSize: 15, lineHeight: 22, color: colors.mutedForeground }}>{project.logline}</Text> : null}
      </View>

      <Card tone="ink">
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ fontFamily: fonts.bold, fontSize: 11, letterSpacing: 1.4, color: colors.accent }}>{(project.seasonLabel || 'Your season').toUpperCase()}</Text>
          <Text style={{ fontFamily: fonts.bold, fontSize: 13, color: inkText }}>{Math.round(seasonProgress)}%</Text>
        </View>
        <ProgressBar value={seasonProgress} tone={colors.accent} />
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
          {stats.map(stat => (
            <View key={stat.label} style={{ alignItems: 'flex-start' }}>
              <Text style={{ fontFamily: fonts.serif, fontSize: 24, color: inkText }}>{stat.value}</Text>
              <Text style={{ fontFamily: fonts.semibold, fontSize: 11, color: inkText, opacity: 0.7 }}>{stat.label}</Text>
            </View>
          ))}
        </View>
      </Card>

      {current ? (
        <>
          <SectionHeader title="Pick up where you left off" />
          <Card>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <Text style={{ fontFamily: fonts.bold, fontSize: 11, letterSpacing: 1, color: colors.coral }}>EPISODE {String(current.number).padStart(2, '0')} · {current.duration}</Text>
              <Badge label={current.status} tone={current.progress >= 100 ? 'success' : 'warning'} />
            </View>
            <Text style={{ fontFamily: fonts.serif, fontSize: 21, color: colors.foreground }}>{current.title}</Text>
            {current.summary ? <Text numberOfLines={3} style={{ fontFamily: fonts.regular, fontSize: 14, lineHeight: 21, color: colors.mutedForeground }}>{current.summary}</Text> : null}
            <ProgressBar value={current.progress} />
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}><Button label="Read scripts" onPress={() => router.push('/stories')} /></View>
              <View style={{ flex: 1 }}><Button variant="secondary" label="Open clips" onPress={() => router.push('/clips')} /></View>
            </View>
          </Card>
        </>
      ) : null}

      <SectionHeader title="The season" caption={`${episodes.length} episode${episodes.length === 1 ? '' : 's'} · pull down to refresh`} />
      {sortedEpisodes.length === 0 ? (
        <EmptyState title="No episodes yet" body="Create your first episode in the web studio. It will show up here automatically." />
      ) : sortedEpisodes.map((episode) => {
        const episodeScenes = scenes.filter((scene) => scene.episodeId === episode.id);
        return (
          <Card key={episode.id}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <Text style={{ fontFamily: fonts.bold, fontSize: 11, letterSpacing: 1, color: colors.coral }}>EPISODE {String(episode.number).padStart(2, '0')} · {episode.duration}</Text>
              {episode.id === current?.id ? <Badge label="Current" tone="warning" /> : null}
            </View>
            <Text style={{ fontFamily: fonts.bold, fontSize: 18, color: colors.foreground }}>{episode.title}</Text>
            {episode.summary ? <Text style={{ fontFamily: fonts.regular, fontSize: 14, lineHeight: 21, color: colors.mutedForeground }}>{episode.summary}</Text> : null}
            <ProgressBar value={episode.progress} />
            <Text style={{ fontFamily: fonts.semibold, fontSize: 12, color: colors.teal }}>{episodeScenes.length} scene{episodeScenes.length === 1 ? '' : 's'} · {episode.progress}% complete</Text>
          </Card>
        );
      })}

      <SectionHeader title="Account & device" />
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Feather name="shield" size={20} color={colors.teal} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text accessibilityLabel="Trusted device status" style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.foreground }}>Trusted device · {device?.deviceLabel ?? 'This device'}</Text>
            {email ? <Text style={{ fontFamily: fonts.regular, fontSize: 13, color: colors.mutedForeground }}>Signed in as {email}</Text> : null}
          </View>
        </View>
        {device?.forgetError ? <Notice tone="error">{device.forgetError}</Notice> : null}
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <View style={{ flex: 1 }}><Button variant="secondary" label="Sign out" testID="mobile-logout" onPress={() => void signOut()} /></View>
          {device ? <View style={{ flex: 1 }}><Button variant="danger" label={device.forgetting ? 'Removing…' : 'Forget device'} loading={device.forgetting} testID="button-forget-device" onPress={() => void device.forget()} /></View> : null}
        </View>
      </Card>
      <Text style={{ textAlign: 'center', fontFamily: fonts.medium, fontSize: 12, color: colors.mutedForeground, marginTop: 6 }}>
        For story development. If a child may be unsafe, involve a trusted safe adult.
      </Text>
    </KeyboardAwareScrollViewCompat>
  );
}
