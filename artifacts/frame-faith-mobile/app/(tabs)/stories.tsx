import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { getGetStudioBootstrapQueryKey, useGetStudioBootstrap } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';

export default function StoriesScreen() {
  const colors = useColors();
  const [openScene, setOpenScene] = useState<number | null>(null);
  const query = useGetStudioBootstrap({ query: { queryKey: getGetStudioBootstrapQueryKey() } });
  if (query.isLoading) return <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>;
  if (query.isError || !query.data) return <View style={styles.center}><Text style={{ color: colors.foreground }}>Stories are unavailable.</Text><Pressable onPress={() => query.refetch()}><Text style={{ color: colors.teal }}>Retry</Text></Pressable></View>;
  const { episodes, scenes, shots } = query.data;
  return <ScrollView contentContainerStyle={[styles.content, { backgroundColor: colors.background }]}>
    <Text style={[styles.kicker, { color: colors.coral }]}>STORY DEPARTMENT</Text>
    <Text style={[styles.title, { color: colors.foreground }]}>Scripts & boards</Text>
    {episodes.map((episode) => <View key={episode.id} style={styles.episode}>
      <Text style={[styles.episodeTitle, { color: colors.foreground }]}>{episode.number}. {episode.title}</Text>
      {scenes.filter(scene => scene.episodeId === episode.id).sort((a,b)=>a.number-b.number).map(scene => {
        const sceneShots=shots.filter(shot=>shot.sceneId===scene.id);
        const expanded=openScene===scene.id;
        return <Pressable key={scene.id} onPress={()=>setOpenScene(expanded?null:scene.id)} style={[styles.card,{backgroundColor:colors.card,borderColor:colors.border}]}>
          <Text style={[styles.sceneNo,{color:colors.teal}]}>SCENE {String(scene.number).padStart(2,'0')} · {scene.duration} · {sceneShots.length} FRAMES</Text>
          <Text style={[styles.sceneTitle,{color:colors.foreground}]}>{scene.heading}</Text>
          <Text style={[styles.body,{color:colors.mutedForeground}]}>{scene.synopsis}</Text>
          {expanded ? <><Text selectable style={[styles.script,{color:colors.foreground}]}>{scene.content}</Text><Text style={[styles.board,{color:colors.coral}]}>STORYBOARD</Text>{sceneShots.sort((a,b)=>a.number-b.number).map(shot=><Text key={shot.id} style={[styles.body,{color:colors.foreground}]}>{shot.number}. {shot.description}</Text>)}</> : <Text style={[styles.tap,{color:colors.teal}]}>Tap to read scene</Text>}
        </Pressable>;
      })}
    </View>)}
  </ScrollView>;
}
const styles=StyleSheet.create({
  center:{flex:1,alignItems:'center',justifyContent:'center',gap:12},
  content:{padding:20,paddingTop:28,paddingBottom:110,gap:14},
  kicker:{fontSize:11,fontWeight:'700',letterSpacing:1.4},
  title:{fontFamily:'Fraunces_600SemiBold',fontSize:29,marginBottom:4},
  episode:{gap:10,marginBottom:12},
  episodeTitle:{fontSize:20,fontWeight:'700',marginTop:8},
  card:{borderWidth:1,borderRadius:16,padding:15,gap:8},
  sceneNo:{fontSize:10,fontWeight:'700',letterSpacing:0.7},
  sceneTitle:{fontFamily:'Manrope_700Bold',fontSize:16},
  body:{fontFamily:'Manrope_400Regular',fontSize:14,lineHeight:21},
  script:{fontFamily:'Manrope_400Regular',fontSize:14,lineHeight:22,marginTop:8},
  board:{fontSize:11,fontWeight:'700',letterSpacing:1.2,marginTop:8},
  tap:{fontSize:12,fontWeight:'600'},
});
