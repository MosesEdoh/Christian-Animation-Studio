import { useState } from 'react';
import { Platform, Pressable, Text, View, ActivityIndicator } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEvent } from 'expo';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { useColors } from '@/hooks/useColors';
import { mediaUrl, useAuth } from '@/lib/auth';

export function PrivateVideo({ url, label }: { url: string; label: string }) {
  const auth = useAuth();
  const colors = useColors();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const uri = mediaUrl(url);
  const player = useVideoPlayer({ uri, headers: auth.headers }, instance => { instance.loop = false; });
  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });
  async function download() {
    setError(''); setPending(true);
    try {
      if (Platform.OS === 'web') {
        const response = await fetch(uri, { credentials: 'include' });
        if (!response.ok) throw new Error('Sign in again to download this video.');
        const objectUrl = URL.createObjectURL(await response.blob());
        const anchor = document.createElement('a'); anchor.href = objectUrl; anchor.download = `${label.replace(/[^a-z0-9-]/gi, '-')}.mp4`; anchor.click();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);
      } else {
        if (!FileSystem.cacheDirectory) throw new Error('File cache is unavailable.');
        const path = `${FileSystem.cacheDirectory}faith-video-${Date.now()}.mp4`;
        const result = await FileSystem.downloadAsync(uri, path, { headers: auth.headers });
        if (result.status !== 200) { await FileSystem.deleteAsync(path, { idempotent: true }); throw new Error('Video download failed. Please sign in again.'); }
        if (!(await Sharing.isAvailableAsync())) throw new Error('File sharing is unavailable on this device.');
        await Sharing.shareAsync(result.uri, { mimeType: 'video/mp4', UTI: 'public.mpeg-4' });
        await FileSystem.deleteAsync(path, { idempotent: true });
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Download failed'); }
    finally { setPending(false); }
  }
  return <View style={{ gap: 10 }}>
    <Text style={{ color: colors.foreground, fontWeight: '700' }}>{label}</Text>
    <VideoView player={player} nativeControls contentFit="contain" style={{ height: 240, width: '100%', borderRadius: 12 }} />
    <Pressable testID="mobile-play-video" accessibilityRole="button" onPress={() => isPlaying ? player.pause() : player.play()} style={{ padding: 14, borderRadius: 12, backgroundColor: colors.secondary }}>
      <Text style={{ color: colors.foreground, textAlign: 'center', fontWeight: '700' }}>{isPlaying ? 'Pause video' : 'Play video'}</Text>
    </Pressable>
    <Pressable testID="mobile-download-video" onPress={download} disabled={pending} style={{ padding: 14, borderRadius: 12, backgroundColor: colors.primary }}>
      {pending ? <ActivityIndicator color={colors.primaryForeground} /> : <Text style={{ color: colors.primaryForeground, fontWeight: '700', textAlign: 'center' }}>Download / save MP4</Text>}
    </Pressable>
    {!!error && <Text style={{ color: colors.destructive }}>{error}</Text>}
  </View>;
}
