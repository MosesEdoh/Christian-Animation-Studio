import type { Clip, Episode, Scene, Shot, StudioBootstrap } from '@workspace/api-client-react';

export const episode: Episode = {
  id: 42, projectId: 1, number: 3, title: 'Hope / lumière',
  summary: 'A story of hope', status: 'draft', progress: 0, duration: '3m',
};
export const otherEpisode: Episode = { ...episode, id: 87, number: 4, title: 'Courage' };
export const scene: Scene = {
  id: 101, episodeId: episode.id, number: 1, heading: 'EXT. GARDEN',
  synopsis: 'Finding hope', content: '', status: 'draft', duration: '10s',
};
export const shot: Shot = {
  id: 201, sceneId: scene.id, number: 1, description: 'The garden',
  shotType: 'wide', movement: 'static', angle: 'eye-level', beat: '',
  duration: '10s', referenceImageUrl: null, status: 'draft',
};
export const clip: Clip = {
  id: 301, shotId: shot.id, provider: 'renderer', status: 'ready',
  url: 'https://media.example/clip.mp4', thumbnailUrl: null,
  duration: '10s', createdAt: '2026-11-09T12:00:00Z',
};
export const bootstrap: StudioBootstrap = {
  project: {
    id: 1, title: 'Test studio', logline: 'Stories of faith', audience: '5–17',
    seasonLabel: 'Season one', activeEpisodeId: otherEpisode.id,
  },
  episodes: [otherEpisode, episode],
  scenes: [scene, { ...scene, id: 102, episodeId: otherEpisode.id }],
  shots: [shot, { ...shot, id: 202, sceneId: 102 }],
  clips: [clip], characters: [], assets: [],
};
