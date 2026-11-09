import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { assetSrc, downloadSeriesPackage } from './lib/seriesPackage';
import { useAuth } from '@workspace/replit-auth-web';
import { MovieExports } from './components/MovieExports';
import { EpisodeDownload } from './components/EpisodeDownload';
import {
  AlertTriangle,
  Aperture,
  ArrowUpRight,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
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
  Download,
  ExternalLink,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  getGetStudioBootstrapQueryKey,
  useCheckSceneContent,
  useCompleteStudioEpisode,
  useCreateStudioAsset,
  useCreateStudioCharacter,
  useCreateStudioScene,
  useCreateStudioShot,
  useGenerateDirectorNotes,
  useGenerateFaithQuestionStory,
  useGenerateSceneDraft,
  useGenerateShotClip,
  useGetStudioBootstrap,
  useReorderStudioShots,
  useSuggestShots,
  useUpdateStudioCharacter,
  useUpdateStudioProject,
  useUpdateStudioScene,
  useUpdateStudioShot,
  useRequestUploadUrl,
  type Character,
  type Clip,
  type Episode,
  type FaithQuestionStory,
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
        <Route path="/" component={StudioGate} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function StudioGate() {
  const auth = useAuth();
  const cache = useQueryClient();
  useEffect(() => { if (!auth.user) cache.clear(); }, [auth.user, cache]);
  if (auth.isLoading) return <div className="content-wrap"><p>Checking private studio access…</p></div>;
  if (!auth.user) return <main className="content-wrap" style={{ maxWidth: 620, margin: '10vh auto' }}>
    <span className="eyebrow">FRAME & FAITH</span><h1>Your private studio</h1>
    <p>Sign in with your approved account to view scripts, references, videos, and downloads.</p>
    {new URLSearchParams(window.location.search).get('access') === 'denied' && <p role="alert">That account is not approved for this studio. Please use your approved account.</p>}
    {auth.error && <p role="alert">{auth.error}</p>}
    <button className="btn btn-primary" onClick={auth.login} data-testid="login-btn">Sign in</button>
  </main>;
  return <StudioWorkspace key={auth.user.id} authUser={auth.user} />;
}

function StudioWorkspace({ authUser }: { authUser: AuthUser }) {
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
  const [sceneHeading, setSceneHeading] = useState('');
  const [sceneSynopsis, setSceneSynopsis] = useState('');
  const [sceneDuration, setSceneDuration] = useState('');
  const [sceneContent, setSceneContent] = useState('');
  const [draftTone, setDraftTone] = useState('Brave, warm, and lightly comic');
  const [directorBeat, setDirectorBeat] = useState('');
  const [shotBeat, setShotBeat] = useState('');
  const [shotPrompt, setShotPrompt] = useState('');
  const [provider, setProvider] = useState('configured');
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
  const authChecked = true;
  const [exportPending, setExportPending] = useState(false);
  const [faithQuestion, setFaithQuestion] = useState('');
  const [faithAgeBand, setFaithAgeBand] = useState<'5-8' | '9-12' | '13-17'>('9-12');
  const [faithQuestionResult, setFaithQuestionResult] = useState<FaithQuestionStory | null>(null);

  const queryClient = useQueryClient();
  const bootstrapQuery = useGetStudioBootstrap({
    query: { queryKey: getGetStudioBootstrapQueryKey() },
  });
  const updateProject = useUpdateStudioProject();
  const createCharacter = useCreateStudioCharacter();
  const updateCharacter = useUpdateStudioCharacter();
  const createAsset = useCreateStudioAsset();
  const requestUploadUrl = useRequestUploadUrl();
  const createScene = useCreateStudioScene();
  const completeEpisode = useCompleteStudioEpisode();
  const updateScene = useUpdateStudioScene();
  const createShot = useCreateStudioShot();
  const updateShot = useUpdateStudioShot();
  const reorderShots = useReorderStudioShots();
  const generateDraft = useGenerateSceneDraft();
  const generateFaithStory = useGenerateFaithQuestionStory();
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
  const sceneHasUnsavedChanges = Boolean(
    activeScene &&
      (sceneHeading !== activeScene.heading ||
        sceneSynopsis !== activeScene.synopsis ||
        sceneDuration !== activeScene.duration ||
        sceneContent !== activeScene.content),
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
      setSceneHeading(activeScene.heading);
      setSceneSynopsis(activeScene.synopsis);
      setSceneDuration(activeScene.duration);
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

  const persistActiveScene = (
    afterSave?: () => void,
    successMessage = 'Scene changes saved to the room.',
  ) => {
    if (!activeScene) return;
    updateScene.mutate(
      {
        id: activeScene.id,
        data: {
          heading: sceneHeading,
          synopsis: sceneSynopsis,
          duration: sceneDuration,
          content: sceneContent,
        },
      },
      {
        onSuccess: (savedScene) => {
          patchBootstrap((current) => ({
            ...current,
            scenes: current.scenes.map((scene) =>
              scene.id === savedScene.id ? savedScene : scene,
            ),
          }));
          afterSave?.();
          if (successMessage) notify(successMessage);
        },
        onError: () => notify('The scene could not be saved. Your edits are still here.', 'error'),
      },
    );
  };

  const selectSceneSafely = (sceneId: number) => {
    if (sceneId === activeScene?.id) return;
    if (sceneHasUnsavedChanges) {
      persistActiveScene(
        () => setSelectedSceneId(sceneId),
        'Scene changes saved before switching.',
      );
      return;
    }
    setSelectedSceneId(sceneId);
  };

  const navigateToView = (nextView: View) => {
    if (nextView === view) return;
    if (sceneHasUnsavedChanges) {
      persistActiveScene(
        () => setView(nextView),
        'Script changes saved before leaving the editor.',
      );
      return;
    }
    setView(nextView);
  };

  const addScene = () => {
    if (!activeEpisode) return;
    const create = () => {
      createScene.mutate(
        {
          data: {
            episodeId: activeEpisode.id,
            heading: 'INT. NEW SCENE - DAY',
            synopsis: '',
            content: '',
            duration: '01:45',
          },
        },
        {
          onSuccess: (scene) => {
            patchBootstrap((current) => ({ ...current, scenes: [...current.scenes, scene] }));
            setSelectedSceneId(scene.id);
            setView('script');
            notify('New scene added to the script.');
          },
          onError: () => notify('A new scene could not be added.', 'error'),
        },
      );
    };
    if (sceneHasUnsavedChanges) {
      persistActiveScene(create, 'Current script saved before adding a scene.');
    } else {
      create();
    }
  };

  const completeActiveEpisode = () => {
    if (!activeEpisode || completeEpisode.isPending) return;
    if (
      episodeScenes.length > 0 &&
      !window.confirm(
        'Generate a complete six-scene script and storyboard for this episode? Existing scene text and the first four storyboard cards per scene will be replaced. Character references and storyboard reference images will be kept.',
      )
    ) {
      return;
    }

    const runCompletion = () => {
      completeEpisode.mutate(
        {
          id: activeEpisode.id,
          data: { ageBand: faithAgeBand },
        },
        {
          onSuccess: (result) => {
            const replacedSceneIds = new Set(result.scenes.map((scene) => scene.id));
            patchBootstrap((current) => ({
              ...current,
              scenes: [
                ...current.scenes.filter(
                  (scene) => scene.episodeId !== result.episodeId || scene.number > 6,
                ),
                ...result.scenes,
              ],
              shots: [
                ...current.shots.filter((shot) => !replacedSceneIds.has(shot.sceneId)),
                ...result.shots,
              ],
            }));
            setSelectedSceneId(result.scenes[0]?.id ?? null);
            setView('script');
            notify(`Episode script completed with ${result.scenes.length} scenes and ${result.shots.length} storyboard cards. References were kept.`);
          },
          onError: () =>
            notify('The full episode could not be generated. Existing scenes and references are unchanged.', 'error'),
        },
      );
    };

    if (sceneHasUnsavedChanges) {
      persistActiveScene(runCompletion, 'Current scene saved before completing the episode.');
    } else {
      runCompletion();
    }
  };

  const addShotToBoard = (suggestion: {
    shotType: string;
    movement: string;
    angle: string;
    rationale: string;
    duration: string;
  }) => {
    if (!activeScene) return;
    createShot.mutate(
      {
        data: {
          sceneId: activeScene.id,
          description: suggestion.rationale,
          shotType: suggestion.shotType,
          movement: suggestion.movement,
          angle: suggestion.angle,
          beat: shotBeat.trim() || activeScene.synopsis || 'Hold on the character’s choice.',
          duration: suggestion.duration,
        },
      },
      {
        onSuccess: (shot) => {
          patchBootstrap((current) => ({ ...current, shots: [...current.shots, shot] }));
          notify('Shot added to the storyboard.');
        },
        onError: () => notify('This shot could not be added to the storyboard.', 'error'),
      },
    );
  };

  const saveShotOrder = (sceneId: number, shotIds: number[]) => {
    reorderShots.mutate(
      { data: { sceneId, shotIds } },
      {
        onSuccess: (savedShots) => {
          patchBootstrap((current) => ({
            ...current,
            shots: [
              ...current.shots.filter((shot) => shot.sceneId !== sceneId),
              ...savedShots,
            ],
          }));
          notify('Storyboard order saved.');
        },
        onError: () => {
          void queryClient.invalidateQueries({ queryKey: getGetStudioBootstrapQueryKey() });
          notify('The storyboard order could not be saved. The saved order was restored.', 'error');
        },
      },
    );
  };

  const saveShot = async (
    shotId: number,
    data: Pick<Shot, 'description' | 'shotType' | 'movement' | 'angle' | 'beat' | 'duration'>,
  ): Promise<boolean> => {
    try {
      const savedShot = await updateShot.mutateAsync({ id: shotId, data });
      patchBootstrap((current) => ({
        ...current,
        shots: current.shots.map((shot) =>
          shot.id === savedShot.id ? savedShot : shot,
        ),
      }));
      notify('Storyboard card updated.');
      return true;
    } catch {
      notify('The storyboard card could not be saved.', 'error');
      return false;
    }
  };

  const createFaithQuestionStory = () => {
    const question = faithQuestion.trim();
    if (question.length < 5) return;
    generateFaithStory.mutate(
      { data: { question, ageBand: faithAgeBand } },
      {
        onSuccess: (result) => {
          setFaithQuestionResult(result);
          notify('A Bible-grounded story pass is ready.');
        },
        onError: () => notify('The faith-question story could not be generated. Try again.', 'error'),
      },
    );
  };

  const useFaithQuestionScene = () => {
    if (!faithQuestionResult) return;
    const currentDraft = sceneContent.trimEnd();
    setSceneContent(
      currentDraft
        ? `${currentDraft}\n\n${faithQuestionResult.sceneDraft}`
        : faithQuestionResult.sceneDraft,
    );
    setView('script');
    notify('Scene sketch added to the end of the script. Save it when ready.');
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
    const upload = await requestUploadUrl.mutateAsync({
      data: { name: file.name, size: file.size, contentType: file.type },
    });
    const put = await fetch(upload.uploadURL, {
      method: 'PUT',
      headers: { 'Content-Type': file.type },
      body: file,
    });
    if (!put.ok) throw new Error('The image could not be uploaded to App Storage.');
    const asset = await createAsset.mutateAsync({
      data: {
        ...metadata,
        objectPath: upload.objectPath,
        name: file.name,
        contentType: file.type,
      },
    });
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
            setSelectedSceneId={selectSceneSafely}
            onAddScene={addScene}
            creatingScenePending={createScene.isPending}
            onCompleteEpisode={completeActiveEpisode}
            completingEpisodePending={completeEpisode.isPending}
            sceneHeading={sceneHeading}
            setSceneHeading={setSceneHeading}
            sceneSynopsis={sceneSynopsis}
            setSceneSynopsis={setSceneSynopsis}
            sceneDuration={sceneDuration}
            setSceneDuration={setSceneDuration}
            sceneContent={sceneContent}
            setSceneContent={setSceneContent}
            sceneHasUnsavedChanges={sceneHasUnsavedChanges}
            saveScene={() => persistActiveScene()}
            saveScenePending={updateScene.isPending}
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
            faithQuestion={faithQuestion}
            setFaithQuestion={setFaithQuestion}
            faithAgeBand={faithAgeBand}
            setFaithAgeBand={setFaithAgeBand}
            faithQuestionResult={faithQuestionResult}
            createFaithQuestionStory={createFaithQuestionStory}
            faithQuestionPending={generateFaithStory.isPending}
            useFaithQuestionScene={useFaithQuestionScene}
          />
        );
      case 'directing':
        return (
          <DirectingView
            activeScene={activeScene}
            scenes={episodeScenes}
            selectedSceneId={selectedSceneId}
            setSelectedSceneId={selectSceneSafely}
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
            setSelectedSceneId={selectSceneSafely}
            shots={sceneShots}
            shotSuggestions={shotSuggestions}
            shotBeat={shotBeat}
            setShotBeat={setShotBeat}
            runShotSuggestions={runShotSuggestions}
            pending={suggestShots.isPending}
            referenceAssets={assets.filter((asset) => asset.sceneId === activeScene?.id && asset.kind === 'storyboard')}
            onAddShot={addShotToBoard}
            creatingShotPending={createShot.isPending}
            onReorderShots={(shotIds) => {
              if (activeScene) saveShotOrder(activeScene.id, shotIds);
            }}
            onSaveShot={saveShot}
            savingShotPending={updateShot.isPending}
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
    return <WorkspaceFrame view={view} setView={navigateToView} authUser={authUser} authChecked={authChecked}><LoadingWorkspace /></WorkspaceFrame>;
  }

  if (bootstrapQuery.isError || !bootstrap) {
    return (
      <WorkspaceFrame view={view} setView={navigateToView} authUser={authUser} authChecked={authChecked}>
        <div className="content-wrap">
          <div className="error-panel" data-testid="panel-bootstrap-error">
            <h2>Studio access unavailable</h2>
            <p>{bootstrapQuery.error instanceof Error ? bootstrapQuery.error.message : 'Sign in with your approved account or try reconnecting.'}</p>
            <a href="/api/logout?returnTo=/" className="btn btn-quiet">Sign out</a>
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
    <WorkspaceFrame view={view} setView={navigateToView} project={project} authUser={authUser} authChecked={authChecked}>
      {renderView()}
      {view === 'dashboard' && <div className="content-wrap"><MovieExports episodes={episodes} /></div>}
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
  const downloadableEpisodeIds = useMemo(() => {
    const sceneEpisodes = new Map(bootstrap.scenes.map((scene) => [scene.id, scene.episodeId]));
    const shotEpisodes = new Map(bootstrap.shots.map((shot) => [shot.id, sceneEpisodes.get(shot.sceneId)]));
    return new Set(bootstrap.clips
      .filter((clip) => clip.status === 'ready' && Boolean(clip.url))
      .map((clip) => shotEpisodes.get(clip.shotId)));
  }, [bootstrap.scenes, bootstrap.shots, bootstrap.clips]);
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
            ZIP includes assembled episode MP4s when clips are downloadable, plus a report for skipped or unavailable clips.
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
                <EpisodeDownload episode={episode} hasClips={downloadableEpisodeIds.has(episode.id)} />
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
  onAddScene,
  creatingScenePending,
  onCompleteEpisode,
  completingEpisodePending,
  sceneHeading,
  setSceneHeading,
  sceneSynopsis,
  setSceneSynopsis,
  sceneDuration,
  setSceneDuration,
  sceneContent,
  setSceneContent,
  sceneHasUnsavedChanges,
  saveScene,
  saveScenePending,
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
  faithQuestion,
  setFaithQuestion,
  faithAgeBand,
  setFaithAgeBand,
  faithQuestionResult,
  createFaithQuestionStory,
  faithQuestionPending,
  useFaithQuestionScene,
}: {
  activeEpisode?: Episode;
  scenes: Scene[];
  activeScene?: Scene;
  selectedSceneId: number | null;
  setSelectedSceneId: (id: number) => void;
  onAddScene: () => void;
  creatingScenePending: boolean;
  onCompleteEpisode: () => void;
  completingEpisodePending: boolean;
  sceneHeading: string;
  setSceneHeading: (value: string) => void;
  sceneSynopsis: string;
  setSceneSynopsis: (value: string) => void;
  sceneDuration: string;
  setSceneDuration: (value: string) => void;
  sceneContent: string;
  setSceneContent: (value: string) => void;
  sceneHasUnsavedChanges: boolean;
  saveScene: () => void;
  saveScenePending: boolean;
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
  faithQuestion: string;
  setFaithQuestion: (value: string) => void;
  faithAgeBand: '5-8' | '9-12' | '13-17';
  setFaithAgeBand: (value: '5-8' | '9-12' | '13-17') => void;
  faithQuestionResult: FaithQuestionStory | null;
  createFaithQuestionStory: () => void;
  faithQuestionPending: boolean;
  useFaithQuestionScene: () => void;
}) {
  return (
    <div className="content-wrap" data-testid="view-script-studio">
      <div className="page-intro">
        <div><p className="eyebrow">01 / story department</p><h1 className="page-title">Put the <span className="display-script">heart</span> on the page.</h1><p className="page-subtitle">Write in plain language. Make the courage specific. Let the lesson arrive through the action.</p></div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-sun" onClick={onCompleteEpisode} disabled={creatingScenePending || completingEpisodePending || !activeEpisode} data-testid="button-complete-episode"><WandSparkles size={14} /> {completingEpisodePending ? 'Completing episode…' : 'Complete episode'}</button>
          <button type="button" className="btn btn-quiet" onClick={onAddScene} disabled={creatingScenePending || !activeEpisode} data-testid="button-add-scene"><Plus size={14} /> {creatingScenePending ? 'Adding…' : 'New scene'}</button>
          <span className="status-pill"><FileText size={13} /> {activeEpisode ? `Episode ${activeEpisode.number} · ${activeEpisode.title}` : 'No episode selected'}</span>
        </div>
      </div>
      <div className="studio-layout">
        <SceneList scenes={scenes} selectedSceneId={selectedSceneId} setSelectedSceneId={setSelectedSceneId} />
        <section className="panel editor-panel" data-testid="panel-script-editor">
          {activeScene ? (
            <>
              <div className="editor-toolbar">
                <div><p className="scene-heading">Scene {String(activeScene.number).padStart(2, '0')} / {activeScene.status}</p><h2 className="editor-heading">{sceneHeading || 'Untitled scene'}</h2><p className="editor-caption">{sceneSynopsis || 'Add a one-line scene intention.'}</p></div>
                <div className="editor-actions">
                  <button type="button" className="btn btn-sun" data-testid="button-generate-draft" onClick={runDraft} disabled={generateDraftPending}><WandSparkles size={14} /> {generateDraftPending ? 'Writing…' : 'Generate pass'}</button>
                  <button type="button" className="btn btn-quiet" data-testid="button-check-scene" onClick={runContentCheck} disabled={checkContentPending}><ShieldCheck size={14} /> {checkContentPending ? 'Checking…' : 'Audience check'}</button>
                  <button type="button" className="btn btn-primary" data-testid="button-save-scene" onClick={saveScene} disabled={saveScenePending || !sceneHasUnsavedChanges}><Save size={14} /> {saveScenePending ? 'Saving…' : sceneHasUnsavedChanges ? 'Save script' : 'Saved'}</button>
                </div>
              </div>
              <div className="form-grid" style={{ marginTop: 17 }}>
                <div className="field"><label htmlFor="scene-heading">Scene heading</label><input id="scene-heading" value={sceneHeading} onChange={(event) => setSceneHeading(event.target.value)} data-testid="input-scene-heading" maxLength={180} /></div>
                <div className="field"><label htmlFor="scene-duration">Screen time (mm:ss)</label><input id="scene-duration" value={sceneDuration} onChange={(event) => setSceneDuration(event.target.value)} data-testid="input-scene-duration" placeholder="01:45" maxLength={8} /></div>
                <div className="field full"><label htmlFor="scene-synopsis">Scene intention</label><textarea id="scene-synopsis" value={sceneSynopsis} onChange={(event) => setSceneSynopsis(event.target.value)} data-testid="input-scene-synopsis" maxLength={1000} /></div>
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
      <FaithQuestionWorkbench
        question={faithQuestion}
        setQuestion={setFaithQuestion}
        ageBand={faithAgeBand}
        setAgeBand={setFaithAgeBand}
        result={faithQuestionResult}
        onGenerate={createFaithQuestionStory}
        pending={faithQuestionPending}
        onUseScene={useFaithQuestionScene}
      />
    </div>
  );
}

function FaithQuestionWorkbench({
  question,
  setQuestion,
  ageBand,
  setAgeBand,
  result,
  onGenerate,
  pending,
  onUseScene,
}: {
  question: string;
  setQuestion: (value: string) => void;
  ageBand: '5-8' | '9-12' | '13-17';
  setAgeBand: (value: '5-8' | '9-12' | '13-17') => void;
  result: FaithQuestionStory | null;
  onGenerate: () => void;
  pending: boolean;
  onUseScene: () => void;
}) {
  return (
    <section className="panel pad" style={{ marginTop: 18 }} data-testid="panel-faith-question-workbench">
      <div className="section-heading">
        <div><p className="eyebrow">Writers’ room / questions worth asking</p><h2>Let a story make room for the hard question.</h2><p>Explore Bible-grounded answers with care, then let a character carry the question into a scene.</p></div>
      </div>
      <div className="insight-box" style={{ marginBottom: 18 }}>
        <p>For story development, not counselling. The question is sent to Gemini to draft a response and is not saved in this project. Don’t include a child’s name or identifying details. If a child may be unsafe, involve a trusted safe adult rather than relying on a story or keeping it secret.</p>
      </div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="faith-question-age">Age range</label>
          <select id="faith-question-age" value={ageBand} onChange={(event) => setAgeBand(event.target.value as '5-8' | '9-12' | '13-17')} data-testid="select-faith-question-age">
            <option value="5-8">5–8</option>
            <option value="9-12">9–12</option>
            <option value="13-17">13–17</option>
          </select>
        </div>
        <div className="field full">
          <label htmlFor="faith-question">A question a character may be afraid to ask</label>
          <textarea id="faith-question" value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={1200} placeholder="For example: If God hears me, why do I still feel alone?" data-testid="input-faith-question" />
          <span className="row-caption">Avoid names and details that could identify a real child.</span>
        </div>
      </div>
      <button type="button" className="btn btn-sun" onClick={onGenerate} disabled={pending || question.trim().length < 5} data-testid="button-generate-faith-story">
        <WandSparkles size={14} /> {pending ? 'Making room for the question…' : 'Explore as a story'}
      </button>
      {result ? (
        <div className="faith-story-result" data-testid="panel-faith-story-result">
          <div className="insight-box">
            <h3>Gentle response</h3><p>{result.answer}</p>
          </div>
          <div className="form-grid" style={{ marginTop: 14 }}>
            <div className="insight-box"><h3>Story premise</h3><p>{result.storyPremise}</p></div>
            <div className="insight-box"><h3>Bible references</h3><p>{result.scriptureReferences.length ? result.scriptureReferences.join(' · ') : 'No references returned'}</p></div>
          </div>
          <div className="insight-box" style={{ marginTop: 14 }}>
            <h3>Scene sketch</h3><p className="faith-scene-draft">{result.sceneDraft}</p>
            <button type="button" className="btn btn-primary" style={{ marginTop: 12 }} onClick={onUseScene} data-testid="button-use-faith-scene"><FileText size={14} /> Append sketch to script</button>
          </div>
          <div className="insight-box" style={{ marginTop: 14 }}><h3>Care note</h3><p>{result.safetyNote}</p></div>
        </div>
      ) : null}
    </section>
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
  onAddShot,
  creatingShotPending,
  onReorderShots,
  onSaveShot,
  savingShotPending,
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
  onAddShot: (suggestion: { shotType: string; movement: string; angle: string; rationale: string; duration: string }) => void;
  creatingShotPending: boolean;
  onReorderShots: (shotIds: number[]) => void;
  onSaveShot: (shotId: number, data: Pick<Shot, 'description' | 'shotType' | 'movement' | 'angle' | 'beat' | 'duration'>) => Promise<boolean>;
  savingShotPending: boolean;
}) {
  const [orderedShots, setOrderedShots] = useState(shots);
  const [draggedShotId, setDraggedShotId] = useState<number | null>(null);
  const [editingShotId, setEditingShotId] = useState<number | null>(null);
  const [shotEdit, setShotEdit] = useState<Pick<Shot, 'description' | 'shotType' | 'movement' | 'angle' | 'beat' | 'duration'> | null>(null);
  const [uploadingReference, setUploadingReference] = useState(false);
  const [referenceError, setReferenceError] = useState('');

  useEffect(() => {
    setOrderedShots(shots);
  }, [shots]);

  const commitShotOrder = (next: Shot[]) => {
    setOrderedShots(next);
    onReorderShots(next.map((shot) => shot.id));
  };

  const moveShot = (targetId: number) => {
    if (draggedShotId === null || draggedShotId === targetId) return;
    const fromIndex = orderedShots.findIndex((shot) => shot.id === draggedShotId);
    const toIndex = orderedShots.findIndex((shot) => shot.id === targetId);
    if (fromIndex < 0 || toIndex < 0) return;
    const next = [...orderedShots];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    commitShotOrder(next);
    setDraggedShotId(null);
  };

  const moveShotByIndex = (fromIndex: number, toIndex: number) => {
    if (toIndex < 0 || toIndex >= orderedShots.length) return;
    const next = [...orderedShots];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    commitShotOrder(next);
  };

  const beginShotEdit = (shot: Shot) => {
    setEditingShotId(shot.id);
    setShotEdit({
      description: shot.description,
      shotType: shot.shotType,
      movement: shot.movement,
      angle: shot.angle,
      beat: shot.beat,
      duration: shot.duration,
    });
  };

  const saveShotEdit = async (shotId: number) => {
    if (!shotEdit) return;
    if (await onSaveShot(shotId, shotEdit)) {
      setEditingShotId(null);
      setShotEdit(null);
    }
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
        {shotSuggestions.length ? <div className="suggestions-grid">{shotSuggestions.map((suggestion, index) => <div className="suggestion-card" key={`${suggestion.shotType}-${index}`} data-testid={`card-shot-suggestion-${index}`}><div className="shot-tags"><span className="shot-tag">{suggestion.shotType}</span><span className="shot-tag">{suggestion.duration}</span></div><h3>{suggestion.movement} · {suggestion.angle}</h3><p>{suggestion.rationale}</p><button type="button" className="btn btn-quiet" style={{ marginTop: 10 }} onClick={() => onAddShot(suggestion)} disabled={creatingShotPending || !activeScene} data-testid={`button-add-shot-${index}`}><Plus size={13} /> {creatingShotPending ? 'Adding…' : 'Add to storyboard'}</button></div>)}</div> : null}
      </section>
      <section className="panel pad" style={{ marginTop: 16 }} data-testid="panel-storyboard">
        <div className="section-heading"><div><h2>Storyboard cards</h2><p>{shots.length ? `${shots.length} saved frames in this scene. Drag or use the order buttons to rearrange.` : 'The first frame is waiting for a beat.'}</p></div><Layers3 size={17} color="var(--coral)" /></div>
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
        {orderedShots.length ? (
          <div className="shot-grid">
            {orderedShots.map((shot, index) => (
              <div
                className="shot-card"
                key={shot.id}
                draggable={editingShotId !== shot.id}
                onDragStart={() => setDraggedShotId(shot.id)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => moveShot(shot.id)}
                data-testid={`card-shot-${shot.id}`}
              >
                <div className="shot-card-toolbar">
                  <span className="shot-index">SHOT {String(index + 1).padStart(2, '0')} · {shot.status}</span>
                  <div className="shot-card-actions">
                    <button type="button" className="icon-button" aria-label={`Move shot ${index + 1} up`} disabled={index === 0} onClick={() => moveShotByIndex(index, index - 1)}><ChevronUp size={14} /></button>
                    <button type="button" className="icon-button" aria-label={`Move shot ${index + 1} down`} disabled={index === orderedShots.length - 1} onClick={() => moveShotByIndex(index, index + 1)}><ChevronDown size={14} /></button>
                    {editingShotId === shot.id ? (
                      <button type="button" className="btn btn-primary" onClick={() => void saveShotEdit(shot.id)} disabled={savingShotPending || !shotEdit?.description.trim()}><Save size={13} /> {savingShotPending ? 'Saving…' : 'Save'}</button>
                    ) : (
                      <button type="button" className="btn btn-quiet" onClick={() => beginShotEdit(shot)}><PenLine size={13} /> Edit</button>
                    )}
                  </div>
                </div>
                {editingShotId === shot.id && shotEdit ? (
                  <div className="form-grid shot-edit-form">
                    <div className="field full"><label htmlFor={`shot-description-${shot.id}`}>Frame description</label><textarea id={`shot-description-${shot.id}`} value={shotEdit.description} onChange={(event) => setShotEdit({ ...shotEdit, description: event.target.value })} /></div>
                    <div className="field"><label htmlFor={`shot-type-${shot.id}`}>Shot type</label><input id={`shot-type-${shot.id}`} value={shotEdit.shotType} onChange={(event) => setShotEdit({ ...shotEdit, shotType: event.target.value })} /></div>
                    <div className="field"><label htmlFor={`shot-movement-${shot.id}`}>Movement</label><input id={`shot-movement-${shot.id}`} value={shotEdit.movement} onChange={(event) => setShotEdit({ ...shotEdit, movement: event.target.value })} /></div>
                    <div className="field"><label htmlFor={`shot-angle-${shot.id}`}>Angle</label><input id={`shot-angle-${shot.id}`} value={shotEdit.angle} onChange={(event) => setShotEdit({ ...shotEdit, angle: event.target.value })} /></div>
                    <div className="field"><label htmlFor={`shot-duration-${shot.id}`}>Duration</label><input id={`shot-duration-${shot.id}`} value={shotEdit.duration} onChange={(event) => setShotEdit({ ...shotEdit, duration: event.target.value })} /></div>
                    <div className="field full"><label htmlFor={`shot-beat-${shot.id}`}>Story beat</label><textarea id={`shot-beat-${shot.id}`} value={shotEdit.beat} onChange={(event) => setShotEdit({ ...shotEdit, beat: event.target.value })} /></div>
                    <button type="button" className="btn btn-quiet" onClick={() => { setEditingShotId(null); setShotEdit(null); }}>Cancel</button>
                  </div>
                ) : (
                  <>
                    <h3>{shot.description}</h3>
                    <div className="shot-tags"><span className="shot-tag">{shot.shotType}</span><span className="shot-tag">{shot.movement}</span><span className="shot-tag">{shot.angle}</span></div>
                    <p className="row-caption" style={{ marginTop: 14 }}>{shot.beat} · {shot.duration}</p>
                  </>
                )}
              </div>
            ))}
          </div>
        ) : <div className="empty-state"><Aperture size={22} /><div><strong>No frames on this scene yet</strong><p>Describe the emotional beat, generate shot ideas, and add the keepers to the board.</p></div></div>}
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
  const playableClips = clips.filter((clip) => clip.status === 'ready' && Boolean(clip.url));
  const [selectedClipId, setSelectedClipId] = useState<number | null>(null);
  const selectedClip = playableClips.find((clip) => clip.id === selectedClipId) ?? playableClips[0];
  const clipInProgress = clips.some((clip) => clip.status === 'queued' || clip.status === 'generating');
  return (
    <div className="content-wrap" data-testid="view-animation">
      <div className="page-intro"><div><p className="eyebrow">04 / animation desk</p><h1 className="page-title">Turn the <span className="display-script">sketch</span> into motion.</h1><p className="page-subtitle">Keep the prompt human. Give the movement a reason. Queue only the clips that serve the story.</p></div><span className="status-pill"><Move3d size={13} /> Render queue</span></div>
      <div className="director-stage">
        <section className="panel prompt-card" data-testid="panel-animation-prompt">
          <div className="field"><label htmlFor="shot-picker">Shot to animate</label><select id="shot-picker" value={selectedShotId ?? ''} onChange={(event) => setSelectedShotId(Number(event.target.value))} data-testid="select-animation-shot">{shots.map((shot) => <option value={shot.id} key={shot.id}>Shot {String(shot.number).padStart(2, '0')} · {shot.description}</option>)}</select></div>
          <div className="insight-box" style={{ marginTop: 18 }}><h3>Frame intention</h3><p>{activeShot?.beat ?? 'Choose a shot to see its intention.'}</p></div>
          <div className="field" style={{ marginTop: 18 }}><label htmlFor="animation-prompt">Motion prompt</label><textarea id="animation-prompt" value={shotPrompt} onChange={(event) => setShotPrompt(event.target.value)} data-testid="input-animation-prompt" placeholder="Describe the movement, texture, and restraint." /></div>
          <div className="form-grid" style={{ marginTop: 15 }}><div className="field full"><label htmlFor="provider-picker">Video renderer</label><select id="provider-picker" value={provider} onChange={(event) => setProvider(event.target.value)} data-testid="select-animation-provider"><option value="configured">Configured external renderer</option></select><span className="row-caption">New AI clips require a configured video provider. No mock files are created. To watch the complete saved story now, build a storyboard MP4 from the dashboard.</span></div></div>
          <button type="button" className="btn btn-primary" style={{ marginTop: 15 }} data-testid="button-generate-clip" onClick={runClipGeneration} disabled={pending || !activeShot}><Play size={14} /> {pending ? 'Queuing clip…' : 'Queue animation clip'}</button>
        </section>
        <section className="panel pad" data-testid="panel-clip-queue">
          <div className="section-heading"><div><h2>Clip queue</h2><p>Generated motion stays attached to the shot.</p></div><Scissors size={17} color="var(--coral)" /></div>
          <div className="clip-preview" data-testid="panel-video-preview">
            {selectedClip?.url ? (
              <>
                <div className="video-stage">
                  <video
                    key={selectedClip.id}
                    src={selectedClip.url}
                    poster={selectedClip.thumbnailUrl ?? undefined}
                    controls
                    preload="metadata"
                    playsInline
                    aria-label={`Preview of ready clip from ${selectedClip.provider}`}
                    data-testid={`video-clip-${selectedClip.id}`}
                  />
                </div>
                <div className="video-caption">
                  <div><span className="eyebrow">Ready to review</span><strong>{selectedClip.provider} · {selectedClip.duration}</strong></div>
                  <div className="video-actions">
                    <a className="btn btn-quiet" href={selectedClip.url} download={`frame-faith-clip-${selectedClip.id}`} data-testid={`download-clip-${selectedClip.id}`}><Download size={14} /> Download</a>
                    <a className="btn btn-primary" href={selectedClip.url} target="_blank" rel="noreferrer" data-testid={`open-clip-${selectedClip.id}`}><ExternalLink size={14} /> Open</a>
                  </div>
                </div>
                {playableClips.length > 1 ? <div className="ready-clip-picker" aria-label="Ready clips">{playableClips.map((clip) => <button type="button" key={clip.id} className={clip.id === selectedClip.id ? 'ready-clip active' : 'ready-clip'} onClick={() => setSelectedClipId(clip.id)} aria-pressed={clip.id === selectedClip.id} data-testid={`button-preview-clip-${clip.id}`}>Clip {clip.id}</button>)}</div> : null}
              </>
            ) : (
              <div className={`video-empty ${clipInProgress ? 'is-loading' : ''}`} role="status" data-testid="state-video-preview-empty">
                {clipInProgress ? <LoaderCircle size={23} className="loading-mark" /> : <Film size={24} />}
                <strong>{clipInProgress ? 'Your frame is in motion' : 'No ready preview yet'}</strong>
                <p>{clipInProgress ? 'The render is still in the queue. This space will open as soon as a ready clip with a video URL arrives.' : clips.some((clip) => clip.status === 'failed') ? 'A render did not make it through. Failed clips stay unavailable here; you can queue another pass from the selected shot.' : 'Queue a clip from a shot. Ready clips with a video URL will appear here with playback controls.'}</p>
              </div>
            )}
          </div>
          {clips.length ? <div className="clip-list">{clips.map((clip) => {
            const canPlay = clip.status === 'ready' && Boolean(clip.url);
            return <div className="clip-row" key={clip.id} data-testid={`row-clip-${clip.id}`}>
              <div className={`clip-thumb ${canPlay ? 'is-ready' : ''}`}>{canPlay ? <Play size={14} /> : clip.status === 'queued' || clip.status === 'generating' ? <LoaderCircle size={14} /> : <Film size={14} />}</div>
              <div><strong>{clip.provider}</strong><span>{clip.status} · {clip.duration}{clip.status === 'ready' && !clip.url ? ' · no video URL' : ''}</span></div>
              {canPlay ? <button type="button" className="btn btn-quiet" onClick={() => setSelectedClipId(clip.id)} aria-label={`Preview ready clip ${clip.id}`} data-testid={`button-select-clip-${clip.id}`}>Preview</button> : <span className="status-text">{clip.status === 'failed' ? 'Unavailable' : clip.status === 'ready' ? 'No URL' : 'In progress'}</span>}
            </div>;
          })}</div> : null}
          {!clips.length ? <div className="empty-state queue-empty" data-testid="state-empty-clip-queue"><Film size={22} /><div><strong>No clips in the queue</strong><p>Pick a shot, write a clear motion prompt, and send the first frame downstream.</p></div></div> : null}
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