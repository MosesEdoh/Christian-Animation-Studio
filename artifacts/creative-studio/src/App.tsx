import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { zipSync, strToU8 } from 'fflate';
import {
  AlertTriangle,
  Aperture,
  ArrowUpRight,
  Camera,
  Check,
  CheckCircle2,
  ChevronRight,
  Clapperboard,
  Clock3,
  FileText,
  Film,
  Layers3,
  Lightbulb,
  LoaderCircle,
  Move3d,
  PenLine,
  Play,
  Plus,
  RefreshCw,
  Save,
  Scissors,
  ShieldCheck,
  Sparkles,
  UsersRound,
  WandSparkles,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  getGetStudioBootstrapQueryKey,
  useCheckSceneContent,
  useCreateStudioCharacter,
  useGenerateDirectorNotes,
  useGenerateSceneDraft,
  useGenerateShotClip,
  useGetStudioBootstrap,
  useSuggestShots,
  useUpdateStudioCharacter,
  useUpdateStudioProject,
  type Character,
  type Clip,
  type Episode,
  type Project,
  type Scene,
  type Shot,
  type StudioAsset,
  type StudioBootstrap,
  type AuthUser,
} from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, Router as WouterRouter, useLocation } from 'wouter';

const queryClient = new QueryClient();

type View = 'dashboard' | 'script' | 'directing' | 'cinematography' | 'animation';
type ToastState = { message: string; kind?: 'error' | 'success' };
type ProjectForm = Pick<Project, 'title' | 'logline' | 'audience' | 'seasonLabel'>;
type CharacterForm = Omit<Character, 'id' | 'projectId'>;

function assetSrc(objectPath: string): string {
  return objectPath.startsWith('/objects/')
    ? `/api/storage${objectPath}`
    : objectPath;
}

async function downloadSeriesPackage(bootstrap: StudioBootstrap): Promise<void> {
  const files: Record<string, Uint8Array> = {};
  const safeName = (value: string) =>
    value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').trim() || 'untitled';
  const projectName = safeName(bootstrap.project.title);
  const episodes: Array<Record<string, unknown>> = [];

  for (const episode of bootstrap.episodes) {
    const episodeScenes = bootstrap.scenes
      .filter((scene) => scene.episodeId === episode.id)
      .sort((a, b) => a.number - b.number);
    const episodeShots = bootstrap.shots
      .filter((shot) => episodeScenes.some((scene) => scene.id === shot.sceneId))
      .sort((a, b) => a.sceneId - b.sceneId || a.number - b.number);
    const episodeClips = bootstrap.clips.filter((clip) =>
      episodeShots.some((shot) => shot.id === clip.shotId),
    );
    const folder = `episodes/E${String(episode.number).padStart(2, '0')}-${safeName(episode.title)}`;
    const script = [
      `${bootstrap.project.title} — EPISODE ${String(episode.number).padStart(2, '0')}: ${episode.title}`,
      episode.summary,
      '',
      ...episodeScenes.flatMap((scene) => [
        scene.heading,
        scene.synopsis,
        '',
        scene.content,
        '',
      ]),
    ].join('\n');
    files[`${folder}/script.txt`] = strToU8(script);
    files[`${folder}/shot-list.json`] = strToU8(JSON.stringify(
      episodeShots.map((shot) => ({
        ...shot,
        sceneHeading: episodeScenes.find((scene) => scene.id === shot.sceneId)?.heading,
        clips: episodeClips.filter((clip) => clip.shotId === shot.id),
      })),
      null,
      2,
    ));
    episodes.push({
      number: episode.number,
      title: episode.title,
      summary: episode.summary,
      status: episode.status,
      progress: episode.progress,
      duration: episode.duration,
      script: `${folder}/script.txt`,
      shotList: `${folder}/shot-list.json`,
    });
  }

  files['character-bible.json'] = strToU8(JSON.stringify(bootstrap.characters, null, 2));
  files['series-manifest.json'] = strToU8(JSON.stringify({
    project: bootstrap.project,
    episodes,
    clips: bootstrap.clips,
    references: bootstrap.assets.map((asset) => ({
      ...asset,
      file: `references/${String(asset.id).padStart(4, '0')}-${safeName(asset.name)}`,
    })),
  }, null, 2));
  files['README.txt'] = strToU8([
    `${bootstrap.project.title} — series production package`,
    '',
    'Included: all episode scripts, shot lists, character bible, uploaded reference images, and clips that the provider makes downloadable.',
    'Provider-hosted clips that cannot be fetched by the browser are listed in clip-links.txt and series-manifest.json.',
    'A mock provider records jobs but does not create video files.',
  ].join('\n'));

  const clipLinks: string[] = [];
  for (const asset of bootstrap.assets) {
    const response = await fetch(assetSrc(asset.objectPath), { credentials: 'include' });
    if (!response.ok) {
      throw new Error(response.status === 401
        ? 'Sign in again to include private reference images in the download.'
        : `Could not download reference image: ${asset.name}`);
    }
    const filename = `${String(asset.id).padStart(4, '0')}-${safeName(asset.name)}`;
    files[`references/${filename}`] = new Uint8Array(await response.arrayBuffer());
  }

  let downloadedVideoBytes = 0;
  for (const clip of bootstrap.clips) {
    if (!clip.url) continue;
    const fileName = `clip-${String(clip.id).padStart(4, '0')}`;
    try {
      const clipUrl = new URL(clip.url, window.location.href);
      if (clipUrl.protocol !== 'https:' && clipUrl.origin !== window.location.origin) {
        throw new Error('Unsupported video URL');
      }
      const response = await fetch(clipUrl, { credentials: 'omit' });
      const contentLength = Number(response.headers.get('content-length') ?? 0);
      if (!response.ok || (contentLength && downloadedVideoBytes + contentLength > 250 * 1024 * 1024)) {
        throw new Error('Video is not directly downloadable');
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.length || downloadedVideoBytes + bytes.length > 250 * 1024 * 1024) {
        throw new Error('Video is larger than the export limit');
      }
      downloadedVideoBytes += bytes.length;
      const mime = response.headers.get('content-type') ?? '';
      const extension = mime.includes('webm') ? 'webm' : mime.includes('quicktime') ? 'mov' : 'mp4';
      files[`clips/${fileName}.${extension}`] = bytes;
    } catch {
      clipLinks.push(`Clip ${clip.id} (${clip.provider}, ${clip.status}): ${clip.url}`);
    }
  }
  if (clipLinks.length) files['clip-links.txt'] = strToU8(clipLinks.join('\n'));

  const archive = zipSync(files, { level: 6 });
  const url = URL.createObjectURL(new Blob([archive], { type: 'application/zip' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${projectName}-series-package.zip`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const navItems: Array<{ id: View; label: string; meta: string; icon: LucideIcon }> = [
  { id: 'dashboard', label: 'Dashboard', meta: '00', icon: Layers3 },
  { id: 'script', label: 'Script Studio', meta: '01', icon: PenLine },
  { id: 'directing', label: 'Directing', meta: '02', icon: Clapperboard },
  { id: 'cinematography', label: 'Cinematography', meta: '03', icon: Camera },
  { id: 'animation', label: 'Animation', meta: '04', icon: Film },
];

const emptyCharacter: CharacterForm = {
  name: '',
  role: '',
  personality: '',
  arc: '',
  faithLesson: '',
  visualNotes: '',
  referenceImageUrl: '',
};

function AppRouter() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={StudioWorkspace} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function StudioWorkspace() {
  const [view, setView] = useState<View>('dashboard');
  const [toast, setToast] = useState<ToastState | null>(null);
  const [showProjectEditor, setShowProjectEditor] = useState(false);
  const [showCharacterEditor, setShowCharacterEditor] = useState(false);
  const [editingCharacter, setEditingCharacter] = useState<Character | null>(null);
  const [projectForm, setProjectForm] = useState<ProjectForm>({
    title: '',
    logline: '',
    audience: '',
    seasonLabel: '',
  });
  const [characterForm, setCharacterForm] = useState<CharacterForm>(emptyCharacter);
  const [selectedSceneId, setSelectedSceneId] = useState<number | null>(null);
  const [selectedShotId, setSelectedShotId] = useState<number | null>(null);
  const [sceneContent, setSceneContent] = useState('');
  const [draftTone, setDraftTone] = useState('Brave, warm, and lightly comic');
  const [directorBeat, setDirectorBeat] = useState('');
  const [shotBeat, setShotBeat] = useState('');
  const [shotPrompt, setShotPrompt] = useState('');
  const [provider, setProvider] = useState('mock');
  const [directorNotes, setDirectorNotes] = useState('');
  const [shotSuggestions, setShotSuggestions] = useState<
    Array<{ shotType: string; movement: string; angle: string; rationale: string; duration: string }>
  >([]);
  const [contentCheck, setContentCheck] = useState<{
    score: number;
    label: string;
    flags: string[];
    suggestions: string[];
  } | null>(null);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [exportPending, setExportPending] = useState(false);

  const queryClient = useQueryClient();
  const bootstrapQuery = useGetStudioBootstrap({
    query: { queryKey: getGetStudioBootstrapQueryKey() },
  });
  const updateProject = useUpdateStudioProject();
  const createCharacter = useCreateStudioCharacter();
  const updateCharacter = useUpdateStudioCharacter();
  const generateDraft = useGenerateSceneDraft();
  const checkContent = useCheckSceneContent();
  const generateNotes = useGenerateDirectorNotes();
  const suggestShots = useSuggestShots();
  const generateClip = useGenerateShotClip();
  const bootstrap = bootstrapQuery.data;
  const project = bootstrap?.project;
  const episodes = bootstrap?.episodes ?? [];
  const scenes = bootstrap?.scenes ?? [];
  const characters = bootstrap?.characters ?? [];
  const shots = bootstrap?.shots ?? [];
  const clips = bootstrap?.clips ?? [];
  const assets = bootstrap?.assets ?? [];

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/user', { credentials: 'include' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Unable to check sign-in');
        return response.json() as Promise<{ user: AuthUser | null }>;
      })
      .then(({ user }) => {
        if (!cancelled) setAuthUser(user);
      })
      .catch(() => {
        if (!cancelled) setAuthUser(null);
      })
      .finally(() => {
        if (!cancelled) setAuthChecked(true);
      });
    return () => { cancelled = true; };
  }, []);

  const activeEpisode = useMemo(
    () => episodes.find((episode) => episode.id === project?.activeEpisodeId) ?? episodes[0],
    [episodes, project?.activeEpisodeId],
  );
  const episodeScenes = useMemo(
    () => scenes.filter((scene) => !activeEpisode || scene.episodeId === activeEpisode.id),
    [activeEpisode, scenes],
  );
  const activeScene = useMemo(
    () => episodeScenes.find((scene) => scene.id === selectedSceneId) ?? episodeScenes[0],
    [episodeScenes, selectedSceneId],
  );
  const sceneShots = useMemo(
    () => shots.filter((shot) => !activeScene || shot.sceneId === activeScene.id),
    [activeScene, shots],
  );
  const activeShot = useMemo(
    () => sceneShots.find((shot) => shot.id === selectedShotId) ?? sceneShots[0],
    [sceneShots, selectedShotId],
  );
  const activeClips = useMemo(
    () => clips.filter((clip) => !activeShot || clip.shotId === activeShot.id),
    [activeShot, clips],
  );

  useEffect(() => {
    if (project) {
      setProjectForm({
        title: project.title,
        logline: project.logline,
        audience: project.audience,
        seasonLabel: project.seasonLabel,
      });
    }
  }, [project]);

  useEffect(() => {
    if (activeScene) {
      setSelectedSceneId(activeScene.id);
      setSceneContent(activeScene.content);
      setDirectorBeat(activeScene.synopsis);
      setShotBeat(activeScene.synopsis);
      setDirectorNotes('');
      setShotSuggestions([]);
      setContentCheck(null);
    }
  }, [activeScene]);

  useEffect(() => {
    if (activeShot) {
      setSelectedShotId(activeShot.id);
      setShotPrompt(activeShot.description);
    }
  }, [activeShot]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 3600);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const notify = (message: string, kind: ToastState['kind'] = 'success') => setToast({ message, kind });

  const patchBootstrap = (patch: (current: StudioBootstrap) => StudioBootstrap) => {
    queryClient.setQueryData<StudioBootstrap>(getGetStudioBootstrapQueryKey(), (current) =>
      current ? patch(current) : current,
    );
  };

  const uploadReferenceAsset = async (
    file: File,
    metadata: {
      kind: 'storyboard' | 'character-reference';
      episodeId?: number | null;
      sceneId?: number | null;
      characterId?: number | null;
    },
  ): Promise<string> => {
    if (!file.type.startsWith('image/')) throw new Error('Choose an image file.');
    if (file.size > 10 * 1024 * 1024) throw new Error('Images must be 10 MB or smaller.');
    const request = await fetch('/api/storage/uploads/request-url', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
    });
    if (request.status === 401) throw new Error('Sign in to upload reference images.');
    if (!request.ok) throw new Error('Could not prepare the image upload.');
    const upload = await request.json() as { uploadURL: string; objectPath: string };
    const put = await fetch(upload.uploadURL, {
      method: 'PUT',
      headers: { 'Content-Type': file.type },
      body: file,
    });
    if (!put.ok) throw new Error('The image could not be uploaded to App Storage.');
    const saved = await fetch('/api/studio/assets', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...metadata,
        objectPath: upload.objectPath,
        name: file.name,
        contentType: file.type,
      }),
    });
    if (!saved.ok) throw new Error('The image uploaded, but its reference could not be saved.');
    const asset = await saved.json() as StudioAsset;
    patchBootstrap((current) => ({ ...current, assets: [...current.assets, asset] }));
    return asset.objectPath;
  };

  const exportSeries = async () => {
    if (!bootstrap) return;
    setExportPending(true);
    try {
      await downloadSeriesPackage(bootstrap);
      notify('Series package downloaded.');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'The series package could not be created.', 'error');
    } finally {
      setExportPending(false);
    }
  };

  const saveProject = () => {
    updateProject.mutate(
      { data: { ...projectForm } },
      {
        onSuccess: (savedProject) => {
          patchBootstrap((current) => ({ ...current, project: savedProject }));
          setShowProjectEditor(false);
          notify('Project card saved to the room.');
        },
        onError: () => notify('The project could not be saved. Try again.', 'error'),
      },
    );
  };

  const openNewCharacter = () => {
    setEditingCharacter(null);
    setCharacterForm(emptyCharacter);
    setShowCharacterEditor(true);
  };

  const openEditCharacter = (character: Character) => {
    setEditingCharacter(character);
    setCharacterForm({
      name: character.name,
      role: character.role,
      personality: character.personality,
      arc: character.arc,
      faithLesson: character.faithLesson,
      visualNotes: character.visualNotes,
      referenceImageUrl: character.referenceImageUrl ?? '',
    });
    setShowCharacterEditor(true);
  };

  const saveCharacter = () => {
    const data = {
      ...characterForm,
      referenceImageUrl:
        characterForm.referenceImageUrl &&
        !characterForm.referenceImageUrl.startsWith('blob:')
          ? characterForm.referenceImageUrl
          : null,
    };
    const options = {
      onSuccess: (savedCharacter: Character) => {
        patchBootstrap((current) => ({
          ...current,
          characters: editingCharacter
            ? current.characters.map((character) =>
                character.id === savedCharacter.id ? savedCharacter : character,
              )
            : [...current.characters, savedCharacter],
        }));
        setShowCharacterEditor(false);
        notify(editingCharacter ? 'Character bible updated.' : 'New character added to the bible.');
      },
      onError: () => notify('The character could not be saved. Try again.', 'error'),
    };
    if (editingCharacter) {
      updateCharacter.mutate({ id: editingCharacter.id, data }, options);
    } else {
      createCharacter.mutate({ data }, options);
    }
  };

  const runDraft = () => {
    generateDraft.mutate(
      {
        data: {
          premise: activeScene?.synopsis || 'A young hero must choose courage when the path home disappears.',
          characters: characters.map((character) => character.name).join(', ') || 'A small team of brave friends',
          tone: draftTone,
        },
      },
      {
        onSuccess: (result) => {
          setSceneContent(result.text);
          notify('A fresh scene pass is on the page.');
        },
        onError: () => notify('Draft service missed its cue. Try again.', 'error'),
      },
    );
  };

  const runContentCheck = () => {
    checkContent.mutate(
      { data: { content: sceneContent } },
      {
        onSuccess: (result) => {
          setContentCheck(result);
          notify('Audience check is ready.');
        },
        onError: () => notify('The audience check could not finish.', 'error'),
      },
    );
  };

  const runDirectorNotes = () => {
    generateNotes.mutate(
      {
        data: {
          scene: activeScene ? `${activeScene.heading}\n${activeScene.synopsis}` : 'The opening scene',
          emotionalBeat: directorBeat,
        },
      },
      {
        onSuccess: (result) => {
          setDirectorNotes(result.text);
          notify('Director notes pinned beside the scene.');
        },
        onError: () => notify('Director notes could not be generated.', 'error'),
      },
    );
  };

  const runShotSuggestions = () => {
    suggestShots.mutate(
      {
        data: {
          scene: activeScene ? `${activeScene.heading}\n${activeScene.synopsis}` : 'A turning point in the story',
          emotionalBeat: shotBeat,
        },
      },
      {
        onSuccess: (result) => {
          setShotSuggestions(result);
          notify('The visual board has new possibilities.');
        },
        onError: () => notify('Shot suggestions could not finish.', 'error'),
      },
    );
  };

  const runClipGeneration = () => {
    if (!activeShot) return;
    generateClip.mutate(
      {
        data: {
          shotId: activeShot.id,
          prompt: shotPrompt,
          referenceImageUrl: activeShot.referenceImageUrl,
          provider,
        },
      },
      {
        onSuccess: (clip) => {
          patchBootstrap((current) => ({ ...current, clips: [clip, ...current.clips] }));
          notify('Clip queued with the animation desk.');
        },
        onError: () => notify('The animation desk could not queue this clip.', 'error'),
      },
    );
  };

  const renderView = () => {
    if (!bootstrap) return null;
    switch (view) {
      case 'script':
        return (
          <ScriptStudio
            activeEpisode={activeEpisode}
            scenes={episodeScenes}
            activeScene={activeScene}
            selectedSceneId={selectedSceneId}
            setSelectedSceneId={setSelectedSceneId}
            sceneContent={sceneContent}
            setSceneContent={setSceneContent}
            draftTone={draftTone}
            setDraftTone={setDraftTone}
            runDraft={runDraft}
            runContentCheck={runContentCheck}
            generateDraftPending={generateDraft.isPending}
            checkContentPending={checkContent.isPending}
            contentCheck={contentCheck}
            characters={characters}
            openNewCharacter={openNewCharacter}
            openEditCharacter={openEditCharacter}
          />
        );
      case 'directing':
        return (
          <DirectingView
            activeScene={activeScene}
            scenes={episodeScenes}
            selectedSceneId={selectedSceneId}
            setSelectedSceneId={setSelectedSceneId}
            directorBeat={directorBeat}
            setDirectorBeat={setDirectorBeat}
            directorNotes={directorNotes}
            runDirectorNotes={runDirectorNotes}
            pending={generateNotes.isPending}
          />
        );
      case 'cinematography':
        return (
          <CinematographyView
            activeScene={activeScene}
            scenes={episodeScenes}
            selectedSceneId={selectedSceneId}
            setSelectedSceneId={setSelectedSceneId}
            shots={sceneShots}
            shotSuggestions={shotSuggestions}
            shotBeat={shotBeat}
            setShotBeat={setShotBeat}
            runShotSuggestions={runShotSuggestions}
            pending={suggestShots.isPending}
            referenceAssets={assets.filter((asset) => asset.sceneId === activeScene?.id && asset.kind === 'storyboard')}
            onUploadReference={(file) => uploadReferenceAsset(file, {
              kind: 'storyboard',
              episodeId: activeEpisode?.id ?? null,
              sceneId: activeScene?.id ?? null,
            })}
          />
        );
      case 'animation':
        return (
          <AnimationView
            activeShot={activeShot}
            shots={sceneShots}
            selectedShotId={selectedShotId}
            setSelectedShotId={setSelectedShotId}
            shotPrompt={shotPrompt}
            setShotPrompt={setShotPrompt}
            provider={provider}
            setProvider={setProvider}
            clips={activeClips}
            runClipGeneration={runClipGeneration}
            pending={generateClip.isPending}
          />
        );
      default:
        return (
          <DashboardView
            project={project}
            episodes={episodes}
            scenes={scenes}
            characters={characters}
            bootstrap={bootstrap}
            exportSeries={exportSeries}
            exportPending={exportPending}
            openProjectEditor={() => setShowProjectEditor(true)}
            openNewCharacter={openNewCharacter}
            openEditCharacter={openEditCharacter}
          />
        );
    }
  };

  if (bootstrapQuery.isLoading) {
    return <WorkspaceFrame view={view} setView={setView} authUser={authUser} authChecked={authChecked}><LoadingWorkspace /></WorkspaceFrame>;
  }

  if (bootstrapQuery.isError || !bootstrap) {
    return (
      <WorkspaceFrame view={view} setView={setView} authUser={authUser} authChecked={authChecked}>
        <div className="content-wrap">
          <div className="error-panel" data-testid="panel-bootstrap-error">
            <h2>The room lights are still warming up.</h2>
            <p>We could not load the studio board. Your work is safe; try reconnecting to the workspace.</p>
            <button
              type="button"
              className="btn btn-primary"
              data-testid="button-retry-bootstrap"
              onClick={() => bootstrapQuery.refetch()}
            >
              <RefreshCw size={14} /> Reconnect
            </button>
          </div>
        </div>
      </WorkspaceFrame>
    );
  }

  return (
    <WorkspaceFrame view={view} setView={setView} project={project} authUser={authUser} authChecked={authChecked}>
      {renderView()}
      {showProjectEditor ? (
        <ProjectEditor
          form={projectForm}
          setForm={setProjectForm}
          onClose={() => setShowProjectEditor(false)}
          onSave={saveProject}
          pending={updateProject.isPending}
        />
      ) : null}
      {showCharacterEditor ? (
        <CharacterEditor
          form={characterForm}
          setForm={setCharacterForm}
          editing={Boolean(editingCharacter)}
          onClose={() => setShowCharacterEditor(false)}
          onSave={saveCharacter}
          pending={createCharacter.isPending || updateCharacter.isPending}
          onUploadReference={(file) => uploadReferenceAsset(file, {
            kind: 'character-reference',
            characterId: editingCharacter?.id ?? null,
          })}
        />
      ) : null}
      {toast ? (
        <div className={`toast-stack`} role="status" data-testid="status-toast">
          <div className={`toast ${toast.kind === 'error' ? 'error' : ''}`}>
            {toast.kind === 'error' ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}
            <span>{toast.message}</span>
          </div>
        </div>
      ) : null}
    </WorkspaceFrame>
  );
}

function WorkspaceFrame({
  children,
  view,
  setView,
  project,
  authUser,
  authChecked,
}: {
  children: ReactNode;
  view: View;
  setView: (view: View) => void;
  project?: Project;
  authUser: AuthUser | null;
  authChecked: boolean;
}) {
  return (
    <div className="studio-app">
      <div className="studio-shell">
        <aside className="studio-sidebar">
          <div className="brand-lockup">
            <div className="brand-mark">F&F</div>
            <div>
              <div className="brand-name">FRAME &amp; FAITH</div>
              <div className="brand-kicker">private animation room</div>
            </div>
          </div>
          <div className="room-label">The room</div>
          <nav className="side-nav" aria-label="Studio views">
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  type="button"
                  key={item.id}
                  className={view === item.id ? 'active' : ''}
                  data-testid={`button-nav-${item.id}`}
                  onClick={() => setView(item.id)}
                >
                  <Icon size={16} strokeWidth={1.8} />
                  <span className="side-nav-label">{item.label}</span>
                  <span className="side-nav-meta">{item.meta}</span>
                </button>
              );
            })}
          </nav>
          <div className="sidebar-foot">
            <div className="signal-card">
              <div className="signal-line"><span className="signal-dot" /> Studio signal</div>
              <strong>Keep the light in the frame.</strong>
              <p>One small, honest scene at a time is still a whole season in motion.</p>
            </div>
          </div>
        </aside>
        <main className="main-canvas">
          <header className="topbar">
            <div className="crumb">
              <span>Frame &amp; Faith</span>
              <ChevronRight size={13} />
              <strong data-testid="text-current-view">{navItems.find((item) => item.id === view)?.label}</strong>
            </div>
            <div className="topbar-actions">
              <span className="status-pill"><span className="signal-dot" /> {project?.seasonLabel ?? 'Workspace ready'}</span>
              {!authChecked ? null : authUser ? (
                <a className="btn btn-quiet" href={`/api/logout?returnTo=${encodeURIComponent(window.location.pathname)}`} data-testid="link-sign-out">Sign out</a>
              ) : (
                <a className="btn btn-quiet" href={`/api/login?returnTo=${encodeURIComponent(window.location.pathname)}`} data-testid="link-sign-in">Sign in to save images</a>
              )}
              <div className="avatar" data-testid="text-creator-avatar">{authUser?.firstName?.slice(0, 1) ?? 'JR'}</div>
            </div>
          </header>
          {children}
        </main>
      </div>
    </div>
  );
}

function LoadingWorkspace() {
  return (
    <div className="content-wrap" data-testid="state-loading-workspace">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Loading the room</p>
          <h1 className="page-title">Setting the lights.</h1>
          <p className="page-subtitle">Pulling the latest pages, people, and picture notes onto the board.</p>
        </div>
      </div>
      <div className="grid-hero">
        <div className="skeleton" />
        <div className="skeleton" />
      </div>
    </div>
  );
}

function DashboardView({
  project,
  episodes,
  scenes,
  characters,
  bootstrap,
  exportSeries,
  exportPending,
  openProjectEditor,
  openNewCharacter,
  openEditCharacter,
}: {
  project?: Project;
  episodes: Episode[];
  scenes: Scene[];
  characters: Character[];
  bootstrap: StudioBootstrap;
  exportSeries: () => void;
  exportPending: boolean;
  openProjectEditor: () => void;
  openNewCharacter: () => void;
  openEditCharacter: (character: Character) => void;
}) {
  const activeEpisode = episodes.find((episode) => episode.id === project?.activeEpisodeId) ?? episodes[0];
  const totalProgress = episodes.length
    ? Math.round(episodes.reduce((sum, episode) => sum + episode.progress, 0) / episodes.length)
    : 0;
  const downloadScript = () => {
    const script = episodes
      .map((episode) => {
        const episodeScenes = scenes.filter((scene) => scene.episodeId === episode.id);
        return [
          `${project?.title ?? 'Untitled project'} — EPISODE ${String(episode.number).padStart(2, '0')}: ${episode.title}`,
          episode.summary,
          '',
          ...episodeScenes.flatMap((scene) => [
            scene.heading,
            '',
            scene.content,
            '',
          ]),
        ].join('\n');
      })
      .join('\n\n');
    const url = URL.createObjectURL(new Blob([script], { type: 'text/plain' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${(project?.title ?? 'creative-studio').replace(/\s+/g, '-').toLowerCase()}-script.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="content-wrap" data-testid="view-dashboard">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Good evening, creator</p>
          <h1 className="page-title">Make room for <span className="display-script">wonder.</span></h1>
          <p className="page-subtitle">Your writers room and animation control room, tuned for the next honest beat.</p>
        </div>
        <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-quiet" data-testid="button-export-series" onClick={exportSeries} disabled={exportPending}>
            <Film size={14} /> {exportPending ? 'Packing…' : 'Download series ZIP'}
          </button>
          <button type="button" className="btn btn-quiet" data-testid="button-export-script" onClick={downloadScript}>
            <FileText size={14} /> Export .txt
          </button>
          <button type="button" className="btn btn-primary" data-testid="button-edit-project" onClick={openProjectEditor}>
            <PenLine size={14} /> Edit project card
          </button>
          <span className="row-caption" style={{ flexBasis: '100%', textAlign: 'right' }}>
            ZIP includes scripts, references, shot lists, and downloadable provider clips when available.
          </span>
        </div>
      </div>
      <div className="grid-hero">
        <section className="panel project-card" data-testid="card-project-summary">
          <div className="project-kicker"><Sparkles size={13} /> Active production</div>
          <h2 className="project-title" data-testid="text-project-title">{project?.title}</h2>
          <p className="project-logline" data-testid="text-project-logline">{project?.logline}</p>
          <div className="project-footer">
            <div>
              <div className="meta-label">Audience</div>
              <div className="meta-value" data-testid="text-project-audience">{project?.audience}</div>
            </div>
            <div className="progress-wrap">
              <div className="progress-header">
                <span className="meta-label">Season progress</span>
                <span className="progress-number" data-testid="text-season-progress">{totalProgress}%</span>
              </div>
              <div className="progress-track"><div className="progress-fill" style={{ width: `${totalProgress}%` }} /></div>
            </div>
          </div>
        </section>
        <section className="panel stats-card" data-testid="card-room-pulse">
          <div className="stats-top">
            <div>
              <div className="meta-label">Current signal</div>
              <div className="stats-big">{activeEpisode ? `${activeEpisode.progress}%` : '—'}</div>
              <p className="stats-copy">{activeEpisode ? `Episode ${activeEpisode.number} · ${activeEpisode.title}` : 'No active episode yet.'}</p>
            </div>
            <div className="sparkline" aria-label="Recent progress">
              {[23, 32, 27, 39, 35, 47, 58, 71].map((height, index) => <i key={index} style={{ height }} />)}
            </div>
          </div>
          <div>
            <div className="meta-label">Next up</div>
            <div className="meta-value">{activeEpisode?.status ?? 'Waiting for a first page'}</div>
          </div>
        </section>
      </div>
      <div className="dashboard-grid">
        <section className="panel pad" data-testid="panel-episodes">
          <div className="section-heading">
            <div><h2>Season board</h2><p>Every episode has a place to land.</p></div>
            <ArrowUpRight size={17} color="var(--coral)" />
          </div>
          {episodes.length ? episodes.map((episode) => (
            <div className="episode-row" key={episode.id} data-testid={`row-episode-${episode.id}`}>
              <div className="episode-number">E{String(episode.number).padStart(2, '0')}</div>
              <div>
                <p className="row-title">{episode.title}</p>
                <p className="row-caption">{episode.summary}</p>
                <div className="tiny-progress"><span style={{ width: `${episode.progress}%` }} /></div>
              </div>
              <div className="status-text">{episode.progress}% · {episode.status}</div>
            </div>
          )) : (
            <div className="empty-state" data-testid="state-empty-episodes"><FileText size={20} /><div><strong>No episodes on the board</strong><p>When the first outline arrives, it will live here.</p></div></div>
          )}
        </section>
        <section className="panel pad" data-testid="panel-character-bible">
          <div className="section-heading">
            <div><h2>Character bible</h2><p>The people carry the lesson.</p></div>
            <button type="button" className="icon-button" data-testid="button-add-character" onClick={openNewCharacter}><Plus size={15} /></button>
          </div>
          {characters.length ? (
            <div className="people-row">
              {characters.map((character) => (
                <button type="button" className="person-chip" key={character.id} data-testid={`button-character-${character.id}`} onClick={() => openEditCharacter(character)}>
                  <strong>{character.name}</strong><span>{character.role}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="empty-state" data-testid="state-empty-characters"><UsersRound size={20} /><div><strong>Start with one brave soul</strong><p>Add a character to give the season a heartbeat.</p></div></div>
          )}
          <button type="button" className="btn btn-quiet" style={{ marginTop: 18 }} data-testid="button-open-character-bible" onClick={openNewCharacter}>
            <Plus size={14} /> Add character
          </button>
        </section>
      </div>
    </div>
  );
}

function SceneList({
  scenes,
  selectedSceneId,
  setSelectedSceneId,
}: {
  scenes: Scene[];
  selectedSceneId: number | null;
  setSelectedSceneId: (id: number) => void;
}) {
  return (
    <div className="list-panel panel" data-testid="panel-scene-list">
      <div className="list-panel-header"><strong>Scenes</strong><span className="meta-label">{String(scenes.length).padStart(2, '0')}</span></div>
      {scenes.length ? scenes.map((scene) => (
        <button type="button" className={`list-item ${selectedSceneId === scene.id ? 'active' : ''}`} key={scene.id} data-testid={`button-scene-${scene.id}`} onClick={() => setSelectedSceneId(scene.id)}>
          <div className="list-item-top"><span className="list-item-title">{String(scene.number).padStart(2, '0')} · {scene.heading}</span><span className="status-text">{scene.status}</span></div>
          <div className="list-item-meta">{scene.duration} · {scene.synopsis}</div>
        </button>
      )) : <div className="empty-state"><FileText size={18} /><div><strong>No scenes yet</strong><p>Choose a premise and let the first page find its shape.</p></div></div>}
    </div>
  );
}

function ScriptStudio({
  activeEpisode,
  scenes,
  activeScene,
  selectedSceneId,
  setSelectedSceneId,
  sceneContent,
  setSceneContent,
  draftTone,
  setDraftTone,
  runDraft,
  runContentCheck,
  generateDraftPending,
  checkContentPending,
  contentCheck,
  characters,
  openNewCharacter,
  openEditCharacter,
}: {
  activeEpisode?: Episode;
  scenes: Scene[];
  activeScene?: Scene;
  selectedSceneId: number | null;
  setSelectedSceneId: (id: number) => void;
  sceneContent: string;
  setSceneContent: (value: string) => void;
  draftTone: string;
  setDraftTone: (value: string) => void;
  runDraft: () => void;
  runContentCheck: () => void;
  generateDraftPending: boolean;
  checkContentPending: boolean;
  contentCheck: { score: number; label: string; flags: string[]; suggestions: string[] } | null;
  characters: Character[];
  openNewCharacter: () => void;
  openEditCharacter: (character: Character) => void;
}) {
  return (
    <div className="content-wrap" data-testid="view-script-studio">
      <div className="page-intro">
        <div><p className="eyebrow">01 / story department</p><h1 className="page-title">Put the <span className="display-script">heart</span> on the page.</h1><p className="page-subtitle">Write in plain language. Make the courage specific. Let the lesson arrive through the action.</p></div>
        <span className="status-pill"><FileText size={13} /> {activeEpisode ? `Episode ${activeEpisode.number} · ${activeEpisode.title}` : 'No episode selected'}</span>
      </div>
      <div className="studio-layout">
        <SceneList scenes={scenes} selectedSceneId={selectedSceneId} setSelectedSceneId={setSelectedSceneId} />
        <section className="panel editor-panel" data-testid="panel-script-editor">
          {activeScene ? (
            <>
              <div className="editor-toolbar">
                <div><p className="scene-heading">Scene {String(activeScene.number).padStart(2, '0')} / {activeScene.status}</p><h2 className="editor-heading">{activeScene.heading}</h2><p className="editor-caption">{activeScene.synopsis}</p></div>
                <div className="editor-actions">
                  <button type="button" className="btn btn-sun" data-testid="button-generate-draft" onClick={runDraft} disabled={generateDraftPending}><WandSparkles size={14} /> {generateDraftPending ? 'Writing…' : 'Generate pass'}</button>
                  <button type="button" className="btn btn-quiet" data-testid="button-check-scene" onClick={runContentCheck} disabled={checkContentPending}><ShieldCheck size={14} /> {checkContentPending ? 'Checking…' : 'Audience check'}</button>
                </div>
              </div>
              <div className="script-paper">
                <textarea value={sceneContent} onChange={(event) => setSceneContent(event.target.value)} data-testid="input-scene-content" aria-label="Scene content" />
              </div>
              <div className="form-grid" style={{ marginTop: 17 }}>
                <div className="field full"><label htmlFor="draft-tone">Pass direction</label><input id="draft-tone" value={draftTone} onChange={(event) => setDraftTone(event.target.value)} data-testid="input-draft-tone" /></div>
              </div>
              {contentCheck ? (
                <div className="insight-box" data-testid="panel-content-check">
                  <h3><CheckCircle2 size={15} style={{ verticalAlign: 'middle', marginRight: 6 }} /> {contentCheck.label} · {contentCheck.score}/100</h3>
                  {contentCheck.flags.length ? <ul>{contentCheck.flags.map((flag) => <li key={flag}>{flag}</li>)}</ul> : <p>Nothing pulled focus from the age-appropriate heart of the scene.</p>}
                  {contentCheck.suggestions.length ? <p style={{ marginTop: 9 }}><strong>Try:</strong> {contentCheck.suggestions.join(' ')}</p> : null}
                </div>
              ) : null}
              <div className="panel pad" style={{ marginTop: 17, background: '#f0ece3' }}>
                <div className="section-heading"><div><h2>People in this scene</h2><p>Keep the emotional geometry visible.</p></div><button type="button" className="btn btn-quiet" data-testid="button-add-character-script" onClick={openNewCharacter}><Plus size={13} /> Add</button></div>
                <div className="people-row">
                  {characters.length ? characters.map((character) => <button type="button" className="person-chip" key={character.id} data-testid={`button-script-character-${character.id}`} onClick={() => openEditCharacter(character)}><strong>{character.name}</strong><span>{character.faithLesson}</span></button>) : <span className="row-caption">No characters yet. Add the first voice to the room.</span>}
                </div>
              </div>
            </>
          ) : <div className="empty-state"><FileText size={22} /><div><strong>Choose a scene to begin</strong><p>The script desk is ready for the next page.</p></div></div>}
        </section>
      </div>
    </div>
  );
}

function ScenePicker({
  scenes,
  selectedSceneId,
  setSelectedSceneId,
}: {
  scenes: Scene[];
  selectedSceneId: number | null;
  setSelectedSceneId: (id: number) => void;
}) {
  return <div className="field"><label htmlFor="scene-picker">Working scene</label><select id="scene-picker" value={selectedSceneId ?? ''} onChange={(event) => setSelectedSceneId(Number(event.target.value))} data-testid="select-working-scene">{scenes.map((scene) => <option value={scene.id} key={scene.id}>{String(scene.number).padStart(2, '0')} · {scene.heading}</option>)}</select></div>;
}

function DirectingView({
  activeScene,
  scenes,
  selectedSceneId,
  setSelectedSceneId,
  directorBeat,
  setDirectorBeat,
  directorNotes,
  runDirectorNotes,
  pending,
}: {
  activeScene?: Scene;
  scenes: Scene[];
  selectedSceneId: number | null;
  setSelectedSceneId: (id: number) => void;
  directorBeat: string;
  setDirectorBeat: (value: string) => void;
  directorNotes: string;
  runDirectorNotes: () => void;
  pending: boolean;
}) {
  return (
    <div className="content-wrap" data-testid="view-directing">
      <div className="page-intro"><div><p className="eyebrow">02 / director's desk</p><h1 className="page-title">Give the <span className="display-script">moment</span> a point of view.</h1><p className="page-subtitle">Direct for the feeling underneath the line. The camera should know what the character is afraid to lose.</p></div><span className="status-pill"><Clapperboard size={13} /> Emotional continuity</span></div>
      <div className="director-stage">
        <section className="panel prompt-card" data-testid="panel-director-prompt">
          <ScenePicker scenes={scenes} selectedSceneId={selectedSceneId} setSelectedSceneId={setSelectedSceneId} />
          <div className="insight-box" style={{ marginTop: 18 }}><h3>Scene intention</h3><p>{activeScene?.synopsis ?? 'Pick a scene to see its intention.'}</p></div>
          <div className="field" style={{ marginTop: 18 }}><label htmlFor="director-beat">Emotional beat</label><textarea id="director-beat" value={directorBeat} onChange={(event) => setDirectorBeat(event.target.value)} data-testid="input-director-beat" placeholder="What changes in the room by the end of this scene?" /></div>
          <button type="button" className="btn btn-primary" style={{ marginTop: 15 }} data-testid="button-generate-director-notes" onClick={runDirectorNotes} disabled={pending || !activeScene}><Sparkles size={14} /> {pending ? 'Finding the angle…' : 'Generate director notes'}</button>
        </section>
        <section className="ai-result" data-testid="panel-director-notes">
          <div className="ai-result-label"><Lightbulb size={14} /> Director's notebook</div>
          {directorNotes ? <p className="ai-result-text">{directorNotes}</p> : <div className="empty-state" style={{ marginTop: 18, minHeight: 230, background: 'rgba(255,255,255,0.4)' }}><Clapperboard size={20} /><div><strong>Notes will land here</strong><p>Generate a pass, then shape it with your own instinct.</p></div></div>}
        </section>
      </div>
    </div>
  );
}

function CinematographyView({
  activeScene,
  scenes,
  selectedSceneId,
  setSelectedSceneId,
  shots,
  shotSuggestions,
  shotBeat,
  setShotBeat,
  runShotSuggestions,
  pending,
  referenceAssets,
  onUploadReference,
}: {
  activeScene?: Scene;
  scenes: Scene[];
  selectedSceneId: number | null;
  setSelectedSceneId: (id: number) => void;
  shots: Shot[];
  shotSuggestions: Array<{ shotType: string; movement: string; angle: string; rationale: string; duration: string }>;
  shotBeat: string;
  setShotBeat: (value: string) => void;
  runShotSuggestions: () => void;
  pending: boolean;
  referenceAssets: StudioAsset[];
  onUploadReference: (file: File) => Promise<string>;
}) {
  const [orderedShots, setOrderedShots] = useState(shots);
  const [draggedShotId, setDraggedShotId] = useState<number | null>(null);
  const [uploadingReference, setUploadingReference] = useState(false);
  const [referenceError, setReferenceError] = useState('');

  useEffect(() => {
    setOrderedShots(shots);
  }, [shots]);

  const moveShot = (targetId: number) => {
    if (draggedShotId === null || draggedShotId === targetId) return;
    const fromIndex = orderedShots.findIndex((shot) => shot.id === draggedShotId);
    const toIndex = orderedShots.findIndex((shot) => shot.id === targetId);
    if (fromIndex < 0 || toIndex < 0) return;
    const next = [...orderedShots];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    setOrderedShots(next);
    setDraggedShotId(null);
  };

  return (
    <div className="content-wrap" data-testid="view-cinematography">
      <div className="page-intro"><div><p className="eyebrow">03 / picture department</p><h1 className="page-title">Find the <span className="display-script">frame</span> that tells it.</h1><p className="page-subtitle">Build a visual rhythm that feels hand-drawn, cinematic, and clear enough for a young eye to follow.</p></div><span className="status-pill"><Aperture size={13} /> Storyboard mode</span></div>
      <section className="panel pad" data-testid="panel-shot-suggestions">
        <div className="form-grid">
          <ScenePicker scenes={scenes} selectedSceneId={selectedSceneId} setSelectedSceneId={setSelectedSceneId} />
          <div className="field"><label htmlFor="shot-beat">Visual beat</label><input id="shot-beat" value={shotBeat} onChange={(event) => setShotBeat(event.target.value)} data-testid="input-shot-beat" placeholder="The instant hope becomes visible" /></div>
        </div>
        <div className="section-heading" style={{ marginTop: 22 }}><div><h2>{activeScene?.heading ?? 'Select a scene'}</h2><p>{activeScene?.synopsis ?? 'Shot suggestions are grounded in the selected scene.'}</p></div><button type="button" className="btn btn-sun" data-testid="button-suggest-shots" onClick={runShotSuggestions} disabled={pending || !activeScene}><WandSparkles size={14} /> {pending ? 'Sketching…' : 'Suggest shots'}</button></div>
        {shotSuggestions.length ? <div className="suggestions-grid">{shotSuggestions.map((suggestion, index) => <div className="suggestion-card" key={`${suggestion.shotType}-${index}`} data-testid={`card-shot-suggestion-${index}`}><div className="shot-tags"><span className="shot-tag">{suggestion.shotType}</span><span className="shot-tag">{suggestion.duration}</span></div><h3>{suggestion.movement} · {suggestion.angle}</h3><p>{suggestion.rationale}</p></div>)}</div> : null}
      </section>
      <section className="panel pad" style={{ marginTop: 16 }} data-testid="panel-storyboard">
        <div className="section-heading"><div><h2>Storyboard cards</h2><p>{shots.length ? `${shots.length} planned frames in this scene. Drag to reorder.` : 'The first frame is waiting for a beat.'}</p></div><Layers3 size={17} color="var(--coral)" /></div>
        <div className="field full" style={{ marginBottom: 18 }}>
          <label htmlFor="storyboard-upload">Reference board or sketch panel</label>
          <input id="storyboard-upload" type="file" accept="image/*" data-testid="input-storyboard-upload" onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              setUploadingReference(true);
              setReferenceError('');
              void onUploadReference(file)
                .catch((error: unknown) => setReferenceError(error instanceof Error ? error.message : 'Upload failed.'))
                .finally(() => setUploadingReference(false));
              event.target.value = '';
            }
          }} />
          {uploadingReference ? <span className="row-caption">Uploading and saving reference…</span> : null}
          {referenceError ? <span className="field-error" role="alert">{referenceError}</span> : null}
        </div>
        {referenceAssets.length ? (
          <div className="storyboard-assets" data-testid="panel-storyboard-upload">
            {referenceAssets.map((asset) => (
              <figure className="storyboard-preview" key={asset.id}>
                <img src={assetSrc(asset.objectPath)} alt={asset.name} />
                <figcaption>{asset.name}</figcaption>
              </figure>
            ))}
          </div>
        ) : null}
        {orderedShots.length ? <div className="shot-grid">{orderedShots.map((shot) => <div className="shot-card" key={shot.id} draggable onDragStart={() => setDraggedShotId(shot.id)} onDragOver={(event) => event.preventDefault()} onDrop={() => moveShot(shot.id)} data-testid={`card-shot-${shot.id}`}><span className="shot-index">SHOT {String(shot.number).padStart(2, '0')} · {shot.status}</span><h3>{shot.description}</h3><div className="shot-tags"><span className="shot-tag">{shot.shotType}</span><span className="shot-tag">{shot.movement}</span><span className="shot-tag">{shot.angle}</span></div><p className="row-caption" style={{ marginTop: 14 }}>{shot.beat} · {shot.duration}</p></div>)}</div> : <div className="empty-state"><Aperture size={22} /><div><strong>No frames on this scene yet</strong><p>Describe the emotional beat above and ask for a visual read.</p></div></div>}
      </section>
    </div>
  );
}

function AnimationView({
  activeShot,
  shots,
  selectedShotId,
  setSelectedShotId,
  shotPrompt,
  setShotPrompt,
  provider,
  setProvider,
  clips,
  runClipGeneration,
  pending,
}: {
  activeShot?: Shot;
  shots: Shot[];
  selectedShotId: number | null;
  setSelectedShotId: (id: number) => void;
  shotPrompt: string;
  setShotPrompt: (value: string) => void;
  provider: string;
  setProvider: (value: string) => void;
  clips: Clip[];
  runClipGeneration: () => void;
  pending: boolean;
}) {
  return (
    <div className="content-wrap" data-testid="view-animation">
      <div className="page-intro"><div><p className="eyebrow">04 / animation desk</p><h1 className="page-title">Turn the <span className="display-script">sketch</span> into motion.</h1><p className="page-subtitle">Keep the prompt human. Give the movement a reason. Queue only the clips that serve the story.</p></div><span className="status-pill"><Move3d size={13} /> Render queue</span></div>
      <div className="director-stage">
        <section className="panel prompt-card" data-testid="panel-animation-prompt">
          <div className="field"><label htmlFor="shot-picker">Shot to animate</label><select id="shot-picker" value={selectedShotId ?? ''} onChange={(event) => setSelectedShotId(Number(event.target.value))} data-testid="select-animation-shot">{shots.map((shot) => <option value={shot.id} key={shot.id}>Shot {String(shot.number).padStart(2, '0')} · {shot.description}</option>)}</select></div>
          <div className="insight-box" style={{ marginTop: 18 }}><h3>Frame intention</h3><p>{activeShot?.beat ?? 'Choose a shot to see its intention.'}</p></div>
          <div className="field" style={{ marginTop: 18 }}><label htmlFor="animation-prompt">Motion prompt</label><textarea id="animation-prompt" value={shotPrompt} onChange={(event) => setShotPrompt(event.target.value)} data-testid="input-animation-prompt" placeholder="Describe the movement, texture, and restraint." /></div>
          <div className="form-grid" style={{ marginTop: 15 }}><div className="field full"><label htmlFor="provider-picker">Video provider</label><select id="provider-picker" value={provider} onChange={(event) => setProvider(event.target.value)} data-testid="select-animation-provider"><option value="mock">Mock preview</option><option value="runway">Runway</option><option value="luma">Luma</option><option value="pika">Pika</option></select><span className="row-caption">The server adapter is selected with VIDEO_PROVIDER; this picker labels the queued clip.</span></div></div>
          <button type="button" className="btn btn-primary" style={{ marginTop: 15 }} data-testid="button-generate-clip" onClick={runClipGeneration} disabled={pending || !activeShot}><Play size={14} /> {pending ? 'Queuing clip…' : 'Queue animation clip'}</button>
        </section>
        <section className="panel pad" data-testid="panel-clip-queue">
          <div className="section-heading"><div><h2>Clip queue</h2><p>Generated motion stays attached to the shot.</p></div><Scissors size={17} color="var(--coral)" /></div>
          {clips.length ? <div className="clip-list">{clips.map((clip) => <div className="clip-row" key={clip.id} data-testid={`row-clip-${clip.id}`}><div className="clip-thumb">{clip.status === 'ready' ? <Play size={14} /> : <LoaderCircle size={14} />}</div><div><strong>{clip.provider}</strong><span>{clip.status} · {clip.duration}</span></div>{clip.url ? <a href={clip.url} target="_blank" rel="noreferrer" className="btn btn-quiet" data-testid={`link-clip-${clip.id}`}>Open</a> : <span className="status-text">In progress</span>}</div>)}</div> : <div className="empty-state" style={{ minHeight: 260 }}><Film size={22} /><div><strong>No clips in the queue</strong><p>Pick a shot, write a clear motion prompt, and send the first frame downstream.</p></div></div>}
        </section>
      </div>
    </div>
  );
}

function ProjectEditor({
  form,
  setForm,
  onClose,
  onSave,
  pending,
}: {
  form: ProjectForm;
  setForm: (form: ProjectForm) => void;
  onClose: () => void;
  onSave: () => void;
  pending: boolean;
}) {
  return (
    <div className="modal-scrim" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="project-editor-title" data-testid="modal-project-editor">
        <div className="modal-header"><div><p className="eyebrow">Project card</p><h2 id="project-editor-title">Name the north star.</h2></div><button type="button" className="icon-button" data-testid="button-close-project-editor" onClick={onClose}><X size={15} /></button></div>
        <div className="form-grid">
          <div className="field full"><label htmlFor="project-title">Title</label><input id="project-title" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} data-testid="input-project-title" /></div>
          <div className="field full"><label htmlFor="project-logline">Logline</label><textarea id="project-logline" value={form.logline} onChange={(event) => setForm({ ...form, logline: event.target.value })} data-testid="input-project-logline" /></div>
          <div className="field"><label htmlFor="project-audience">Audience</label><input id="project-audience" value={form.audience} onChange={(event) => setForm({ ...form, audience: event.target.value })} data-testid="input-project-audience" /></div>
          <div className="field"><label htmlFor="project-season">Season label</label><input id="project-season" value={form.seasonLabel} onChange={(event) => setForm({ ...form, seasonLabel: event.target.value })} data-testid="input-project-season" /></div>
        </div>
        <div className="form-actions"><button type="button" className="btn btn-quiet" data-testid="button-cancel-project-editor" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" data-testid="button-save-project" onClick={onSave} disabled={pending}><Save size={14} /> {pending ? 'Saving…' : 'Save project'}</button></div>
      </div>
    </div>
  );
}

function CharacterEditor({
  form,
  setForm,
  editing,
  onClose,
  onSave,
  pending,
  onUploadReference,
}: {
  form: CharacterForm;
  setForm: (form: CharacterForm) => void;
  editing: boolean;
  onClose: () => void;
  onSave: () => void;
  pending: boolean;
  onUploadReference: (file: File) => Promise<string>;
}) {
  const update = (key: keyof CharacterForm, value: string) => setForm({ ...form, [key]: value });
  const [uploadingReference, setUploadingReference] = useState(false);
  const [referenceError, setReferenceError] = useState('');
  return (
    <div className="modal-scrim" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="character-editor-title" data-testid="modal-character-editor">
        <div className="modal-header"><div><p className="eyebrow">Character bible</p><h2 id="character-editor-title">{editing ? 'Refine the character.' : 'Give the story a voice.'}</h2></div><button type="button" className="icon-button" data-testid="button-close-character-editor" onClick={onClose}><X size={15} /></button></div>
        <div className="form-grid">
          <div className="field"><label htmlFor="character-name">Name</label><input id="character-name" value={form.name} onChange={(event) => update('name', event.target.value)} data-testid="input-character-name" /></div>
          <div className="field"><label htmlFor="character-role">Role</label><input id="character-role" value={form.role} onChange={(event) => update('role', event.target.value)} data-testid="input-character-role" /></div>
          <div className="field full"><label htmlFor="character-personality">Personality</label><textarea id="character-personality" value={form.personality} onChange={(event) => update('personality', event.target.value)} data-testid="input-character-personality" /></div>
          <div className="field"><label htmlFor="character-arc">Arc</label><textarea id="character-arc" value={form.arc} onChange={(event) => update('arc', event.target.value)} data-testid="input-character-arc" /></div>
          <div className="field"><label htmlFor="character-lesson">Faith lesson</label><textarea id="character-lesson" value={form.faithLesson} onChange={(event) => update('faithLesson', event.target.value)} data-testid="input-character-lesson" /></div>
          <div className="field full"><label htmlFor="character-visual-notes">Visual notes</label><textarea id="character-visual-notes" value={form.visualNotes} onChange={(event) => update('visualNotes', event.target.value)} data-testid="input-character-visual-notes" /></div>
          <div className="field full"><label htmlFor="character-reference">Reference image URL (optional)</label><input id="character-reference" value={form.referenceImageUrl ?? ''} onChange={(event) => update('referenceImageUrl', event.target.value)} data-testid="input-character-reference" /></div>
          <div className="field full"><label htmlFor="character-reference-upload">Upload a persistent reference image</label><input id="character-reference-upload" type="file" accept="image/*" data-testid="input-character-reference-upload" onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              setUploadingReference(true);
              setReferenceError('');
              void onUploadReference(file)
                .then((objectPath) => update('referenceImageUrl', objectPath))
                .catch((error: unknown) => setReferenceError(error instanceof Error ? error.message : 'Upload failed.'))
                .finally(() => setUploadingReference(false));
              event.target.value = '';
            }
          }} />{uploadingReference ? <span className="row-caption">Uploading and saving reference…</span> : null}
          {referenceError ? <span className="field-error" role="alert">{referenceError}</span> : null}
          {form.referenceImageUrl ? <img className="reference-preview" src={assetSrc(form.referenceImageUrl)} alt={`${form.name || 'Character'} reference preview`} /> : null}</div>
        </div>
        <div className="form-actions"><button type="button" className="btn btn-quiet" data-testid="button-cancel-character-editor" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" data-testid="button-save-character" onClick={onSave} disabled={pending || uploadingReference || !form.name.trim()}><Save size={14} /> {pending ? 'Saving…' : editing ? 'Save changes' : 'Add character'}</button></div>
      </div>
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <AppRouter />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;