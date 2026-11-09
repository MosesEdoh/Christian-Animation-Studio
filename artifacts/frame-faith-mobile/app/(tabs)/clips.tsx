import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { VideoView, useVideoPlayer } from 'expo-video';
import { getGetStudioBootstrapQueryKey, type Clip, useGetStudioBootstrap } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';

function ClipPreview({ clip }: { clip: Clip }) {
  const colors = useColors();
  const player = useVideoPlayer(clip.url ?? '', instance => { instance.loop = false; });
  return <View style={[styles.card,{backgroundColor:colors.card,borderColor:colors.border}]}>
    <Text style={[styles.name,{color:colors.foreground}]}>{clip.provider} · {clip.duration}</Text>
    <VideoView player={player} nativeControls style={styles.video} contentFit="contain" />
    <Pressable accessibilityRole="link" accessibilityLabel="Open or download original clip" testID={`mobile-download-${clip.id}`} onPress={()=>clip.url && Linking.openURL(clip.url)}>
      <Text style={[styles.link,{color:colors.teal}]}>Open original clip</Text>
    </Pressable>
  </View>;
}
export default function ClipsScreen() {
  const colors=useColors();
  const query=useGetStudioBootstrap({query:{queryKey:getGetStudioBootstrapQueryKey()}});
  if(query.isLoading)return <View style={styles.center}><ActivityIndicator color={colors.primary}/></View>;
  if(query.isError||!query.data)return <View style={styles.center}><Text style={{color:colors.foreground}}>Clips could not load.</Text><Pressable onPress={()=>query.refetch()}><Text style={{color:colors.teal}}>Retry</Text></Pressable></View>;
  const ready=query.data.clips.filter(clip=>clip.status==='ready'&&Boolean(clip.url));
  return <ScrollView contentContainerStyle={[styles.content,{backgroundColor:colors.background}]}>
    <Text style={[styles.kicker,{color:colors.coral}]}>ANIMATION DESK</Text>
    <Text style={[styles.title,{color:colors.foreground}]}>Preview clips</Text>
    <Text style={[styles.sub,{color:colors.mutedForeground}]}>Watch finished clips here before opening the original download.</Text>
    {ready.length?ready.map(clip=><ClipPreview key={clip.id} clip={clip}/>):<View style={[styles.empty,{backgroundColor:colors.card,borderColor:colors.border}]}><Text style={[styles.emptyTitle,{color:colors.foreground}]}>No finished videos yet</Text><Text style={[styles.sub,{color:colors.mutedForeground}]}>When a provider returns a ready clip, it will appear here with playback controls.</Text></View>}
  </ScrollView>;
}
const styles=StyleSheet.create({
  center:{flex:1,alignItems:'center',justifyContent:'center',gap:12},
  content:{padding:20,paddingTop:28,paddingBottom:110,gap:14},
  kicker:{fontSize:11,fontWeight:'700',letterSpacing:1.4},
  title:{fontSize:29,fontWeight:'700'},
  sub:{fontSize:14,lineHeight:21},
  card:{borderWidth:1,borderRadius:18,padding:14,gap:12},
  name:{fontSize:15,fontWeight:'700'},
  video:{width:'100%',height:220,borderRadius:12},
  link:{fontSize:14,fontWeight:'700',paddingVertical:6},
  empty:{borderWidth:1,borderRadius:18,padding:20,gap:8,marginTop:8},
  emptyTitle:{fontSize:18,fontWeight:'700'},
});
