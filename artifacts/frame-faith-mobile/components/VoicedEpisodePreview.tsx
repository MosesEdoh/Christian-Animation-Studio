import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, Text, View } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { useAuth } from '@clerk/expo';
import { customFetch } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { mediaSource } from '@/lib/media';
import { mediaUrl } from '@/lib/clerk';

export function VoicedEpisodePreview({
  episodeId,
  episodeTitle,
  hasClips,
}: {
  episodeId: number;
  episodeTitle: string;
  hasClips: boolean;
}) {
  const auth = useAuth();
  const colors = useColors();
  const player = useVideoPlayer(null, instance => { instance.loop = false; });
  const [videoUri, setVideoUri] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const ownedUri = useRef('');
  const requestController = useRef<AbortController | null>(null);
  const downloadTask = useRef<ReturnType<typeof FileSystem.createDownloadResumable> | null>(null);
  const temporaryPath = useRef('');
  const endpoint = `/api/studio/episodes/${episodeId}/video`;
  const absoluteUrl = mediaUrl(endpoint);

  useEffect(() => () => {
    requestController.current?.abort();
    requestController.current = null;
    void downloadTask.current?.cancelAsync().catch(() => undefined);
    downloadTask.current = null;
    if (temporaryPath.current) void FileSystem.deleteAsync(temporaryPath.current, { idempotent: true }).catch(() => undefined);
    player.pause();
    const uri = ownedUri.current;
    ownedUri.current = '';
    if (!uri) return;
    if (Platform.OS === 'web') URL.revokeObjectURL(uri);
    else void FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
  }, [player]);

  async function preparePreview() {
    if (requestController.current || !hasClips) return;
    const controller = new AbortController();
    requestController.current = controller;
    setPending(true);
    setError('');
    const previousUri = ownedUri.current;
    ownedUri.current = '';
    if (previousUri) {
      if (Platform.OS === 'web') URL.revokeObjectURL(previousUri);
      else await FileSystem.deleteAsync(previousUri, { idempotent: true }).catch(() => undefined);
    }
    setVideoUri('');
    try {
      let localUri: string;
      if (Platform.OS === 'web') {
        const response = await customFetch<Response>(absoluteUrl, {
          responseType: 'response',
          credentials: 'omit',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Episode assembly failed.');
        localUri = URL.createObjectURL(await response.blob());
      } else {
        if (!FileSystem.cacheDirectory) throw new Error('The device video cache is unavailable.');
        const source = await mediaSource(endpoint, `https://${process.env.EXPO_PUBLIC_DOMAIN}`, auth.getToken);
        const destination = `${FileSystem.cacheDirectory}voiced-episode-${episodeId}-${Date.now()}.mp4`;
        temporaryPath.current = destination;
        const task = FileSystem.createDownloadResumable(source.uri, destination, { headers: source.headers });
        downloadTask.current = task;
        const downloaded = await task.downloadAsync();
        if (!downloaded) throw new Error('Episode assembly was cancelled.');
        if (downloaded.status !== 200) {
          await FileSystem.deleteAsync(destination, { idempotent: true });
          temporaryPath.current = '';
          throw new Error('Episode assembly failed.');
        }
        const info = await FileSystem.getInfoAsync(downloaded.uri);
        if (!info.exists || !info.size) {
          await FileSystem.deleteAsync(downloaded.uri, { idempotent: true });
          temporaryPath.current = '';
          throw new Error('The episode video file was empty.');
        }
        localUri = downloaded.uri;
      }
      await player.replaceAsync({ uri: localUri });
      ownedUri.current = localUri;
      setVideoUri(localUri);
      player.play();
    } catch {
      if (!controller.signal.aborted) {
        setError('Could not prepare the voiced episode. Check sign-in, ready clips, and saved dialogue, then retry.');
      }
    } finally {
      if (requestController.current === controller) {
        requestController.current = null;
        downloadTask.current = null;
        temporaryPath.current = '';
        setPending(false);
      }
    }
  }

  async function cancelPreview() {
    requestController.current?.abort();
    await downloadTask.current?.cancelAsync().catch(() => undefined);
    if (temporaryPath.current) {
      await FileSystem.deleteAsync(temporaryPath.current, { idempotent: true }).catch(() => undefined);
    }
  }

  async function shareVideo() {
    if (!videoUri) return;
    try {
      if (Platform.OS === 'web') {
        const anchor = document.createElement('a');
        anchor.href = videoUri;
        anchor.download = `frame-faith-episode-${episodeId}.mp4`;
        anchor.click();
        return;
      }
      if (!(await Sharing.isAvailableAsync())) throw new Error('File sharing is unavailable on this device.');
      await Sharing.shareAsync(videoUri, { mimeType: 'video/mp4', UTI: 'public.mpeg-4' });
    } catch {
      setError('The voiced video is ready, but this device could not share the file.');
    }
  }

  return (
    <View style={{ padding: 16, gap: 10, borderRadius: 18, backgroundColor: colors.card }}>
      <Text style={{ color: colors.foreground, fontSize: 18, fontWeight: '700' }}>
        Episode {episodeTitle} · character voices
      </Text>
      <Text style={{ color: colors.mutedForeground, lineHeight: 20 }}>
        Builds the episode from ready clips and speaks saved screenplay lines with distinct synthetic voices shaped by each character’s personality. This is separate from silent storyboard movies.
      </Text>
      <Pressable
        testID="mobile-build-voiced-episode"
        accessibilityRole="button"
        accessibilityState={{ disabled: pending || !hasClips }}
        disabled={pending || !hasClips}
        onPress={() => void preparePreview()}
        style={{ padding: 13, borderRadius: 12, backgroundColor: colors.primary, opacity: pending || !hasClips ? 0.65 : 1 }}
      >
        {pending
          ? <ActivityIndicator color={colors.primaryForeground} />
          : <Text style={{ color: colors.primaryForeground, textAlign: 'center', fontWeight: '700' }}>
              {videoUri ? 'Rebuild voiced episode preview' : 'Build & preview voiced episode MP4'}
            </Text>}
      </Pressable>
      {pending ? (
        <Pressable
          testID="mobile-cancel-voiced-episode"
          accessibilityRole="button"
          onPress={() => void cancelPreview()}
          style={{ padding: 12, borderRadius: 12, backgroundColor: colors.secondary }}
        >
          <Text style={{ color: colors.foreground, textAlign: 'center' }}>Cancel preview</Text>
        </Pressable>
      ) : null}
      {!hasClips ? <Text style={{ color: colors.mutedForeground }}>This episode has no ready video clips to assemble yet.</Text> : null}
      {videoUri ? (
        <>
          <VideoView
            player={player}
            nativeControls
            contentFit="contain"
            style={{ height: 240, width: '100%', borderRadius: 12 }}
            testID="mobile-voiced-episode-player"
          />
          <Pressable
            testID="mobile-share-voiced-episode"
            accessibilityRole="button"
            onPress={() => void shareVideo()}
            style={{ padding: 13, borderRadius: 12, backgroundColor: colors.secondary }}
          >
            <Text style={{ color: colors.foreground, textAlign: 'center', fontWeight: '700' }}>Save / share MP4</Text>
          </Pressable>
        </>
      ) : null}
      {!!error && <Text accessibilityRole="alert" style={{ color: colors.destructive }}>{error}</Text>}
    </View>
  );
}
