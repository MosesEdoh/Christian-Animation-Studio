import { Router, type IRouter } from "express";
import { asc, count, eq } from "drizzle-orm";
import {
  CheckSceneContentBody,
  CheckSceneContentResponse,
  CreateStudioCharacterBody,
  CreateStudioCharacterResponse,
  CreateStudioAssetBody,
  CreateStudioAssetResponse,
  GenerateDirectorNotesBody,
  GenerateDirectorNotesResponse,
  GenerateSceneDraftBody,
  GenerateSceneDraftResponse,
  GenerateShotClipBody,
  GenerateShotClipResponse,
  GetStudioBootstrapResponse,
  SuggestShotsBody,
  SuggestShotsResponse,
  UpdateStudioCharacterBody,
  UpdateStudioCharacterParams,
  UpdateStudioCharacterResponse,
  UpdateStudioProjectBody,
  UpdateStudioProjectResponse,
} from "@workspace/api-zod";
import {
  db,
  studioCharactersTable,
  studioClipsTable,
  studioEpisodesTable,
  studioProjectsTable,
  studioScenesTable,
  studioShotsTable,
  studioAssetsTable,
} from "@workspace/db";
import { generateGeminiJson, generateGeminiText } from "../lib/ai";
import { submitVideoGeneration } from "../lib/video-provider";

const router: IRouter = Router();

async function ensureStudioSeed(): Promise<void> {
  const [{ value: projectCount }] = await db
    .select({ value: count() })
    .from(studioProjectsTable);
  if (Number(projectCount) > 0) return;

  await db.transaction(async (tx) => {
    const [project] = await tx
      .insert(studioProjectsTable)
      .values({
        title: "The Lightbearer",
        logline:
          "When a quiet student discovers courage is stronger than fear, an ordinary school becomes the front line for a new kind of battle.",
        audience: "Ages 5–17 · family adventure",
        seasonLabel: "Season 01 · The First Light",
        activeEpisodeId: 1,
      })
      .returning();

    const episodes = await tx
      .insert(studioEpisodesTable)
      .values([
        {
          projectId: project.id,
          number: 1,
          title: "The First Light",
          summary: "A hidden call. A brave yes.",
          status: "storyboarding",
          progress: 68,
          duration: "11:30",
        },
        {
          projectId: project.id,
          number: 2,
          title: "The Narrow Way",
          summary: "The shortcut asks too much.",
          status: "scripting",
          progress: 32,
          duration: "12:00",
        },
        {
          projectId: project.id,
          number: 3,
          title: "Not Alone",
          summary: "Courage becomes a chorus.",
          status: "scripting",
          progress: 18,
          duration: "11:45",
        },
      ])
      .returning();

    await tx
      .update(studioProjectsTable)
      .set({ activeEpisodeId: episodes[0].id })
      .where(eq(studioProjectsTable.id, project.id));

    const scenes = await tx
      .insert(studioScenesTable)
      .values([
        {
          episodeId: episodes[0].id,
          number: 1,
          heading: "INT. SCHOOL HALLWAY — LATE AFTERNOON",
          synopsis:
            "Mara chooses to stop running when the frightened first-year student drops his books.",
          content:
            "MARA\n(quietly)\nYou do not have to carry all of that by yourself.\n\nA locker door shudders at the far end of the hall. The lights flicker. Mara looks up, then steps between the sound and the younger student.",
          status: "review",
          duration: "01:35",
        },
        {
          episodeId: episodes[0].id,
          number: 2,
          heading: "EXT. OLD CHAPEL STEPS — BLUE HOUR",
          synopsis:
            "The team learns the light responds to trust, not volume.",
          content:
            "JONAH\nThe light is not a weapon.\n\nMARA\nThen why does it feel like one?\n\nJonah opens his hand. The glow steadies when they stand together.",
          status: "draft",
          duration: "02:10",
        },
      ])
      .returning();

    await tx.insert(studioCharactersTable).values([
      {
        projectId: project.id,
        name: "Mara",
        role: "Reluctant lightbearer",
        personality: "Observant, funny when nervous, fiercely protective.",
        arc: "From hiding her gifts to trusting the people who stand with her.",
        faithLesson: "Courage grows when we choose truth over fear.",
        visualNotes: "Copper curls, navy school jacket, warm gold light at the hands.",
        referenceImageUrl: null,
      },
      {
        projectId: project.id,
        name: "Jonah",
        role: "Steady friend",
        personality: "Patient, inventive, and quietly brave.",
        arc: "From fixing everything alone to learning to receive help.",
        faithLesson: "Wisdom can be gentle and still move first.",
        visualNotes: "Round glasses, teal hoodie, sketchbook with star maps.",
        referenceImageUrl: null,
      },
      {
        projectId: project.id,
        name: "The Hush",
        role: "Shadow force",
        personality: "Imposing without cruelty; feeds on isolation.",
        arc: "A pressure the team learns to name instead of fear.",
        faithLesson: "What is hidden loses power when brought into the light.",
        visualNotes: "Soft-edged ink silhouette, violet rim light, no graphic violence.",
        referenceImageUrl: null,
      },
    ]);

    await tx.insert(studioShotsTable).values([
      {
        sceneId: scenes[0].id,
        number: 1,
        description: "Mara notices the dropped books before the hallway does.",
        shotType: "Medium close-up",
        movement: "Slow push-in",
        angle: "Eye level",
        beat: "Attention becomes compassion.",
        duration: "00:04",
        referenceImageUrl: null,
        status: "planned",
      },
      {
        sceneId: scenes[0].id,
        number: 2,
        description: "A locker shudders in the distance as Mara steps forward.",
        shotType: "Wide",
        movement: "Dolly back",
        angle: "Low angle",
        beat: "A small choice feels enormous.",
        duration: "00:05",
        referenceImageUrl: null,
        status: "planned",
      },
      {
        sceneId: scenes[0].id,
        number: 3,
        description: "Warm light gathers around Mara's hand, soft not sharp.",
        shotType: "Insert",
        movement: "Orbit",
        angle: "Three-quarter",
        beat: "Power answers to purpose.",
        duration: "00:04",
        referenceImageUrl: null,
        status: "queued",
      },
    ]);
  });
}

router.get("/studio/bootstrap", async (req, res): Promise<void> => {
  await ensureStudioSeed();
  const [project] = await db.select().from(studioProjectsTable).limit(1);
  const episodes = await db
    .select()
    .from(studioEpisodesTable)
    .orderBy(asc(studioEpisodesTable.number));
  const scenes = await db
    .select()
    .from(studioScenesTable)
    .orderBy(asc(studioScenesTable.episodeId), asc(studioScenesTable.number));
  const characters = await db
    .select()
    .from(studioCharactersTable)
    .orderBy(asc(studioCharactersTable.id));
  const shots = await db
    .select()
    .from(studioShotsTable)
    .orderBy(asc(studioShotsTable.sceneId), asc(studioShotsTable.number));
  const clips = await db
    .select()
    .from(studioClipsTable)
    .orderBy(asc(studioClipsTable.createdAt));
  const assets = await db
    .select()
    .from(studioAssetsTable)
    .orderBy(asc(studioAssetsTable.createdAt));

  req.log.info(
    { projectId: project?.id, episodeCount: episodes.length },
    "Loaded studio bootstrap",
  );
  res.json(
    GetStudioBootstrapResponse.parse({
      project,
      episodes,
      scenes,
      characters,
      shots,
      clips,
      assets,
    }),
  );
});

router.post("/studio/assets", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Sign in to save reference images" });
    return;
  }
  const parsed = CreateStudioAssetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!parsed.data.objectPath.startsWith("/objects/")) {
    res.status(400).json({ error: "Invalid App Storage object path" });
    return;
  }
  if (!parsed.data.contentType.startsWith("image/")) {
    res.status(400).json({ error: "Reference assets must be images" });
    return;
  }
  const [project] = await db.select().from(studioProjectsTable).limit(1);
  if (!project) {
    res.status(404).json({ error: "Studio project not found" });
    return;
  }
  const [asset] = await db
    .insert(studioAssetsTable)
    .values({ ...parsed.data, projectId: project.id })
    .returning();
  res.status(201).json(CreateStudioAssetResponse.parse(asset));
});

router.patch("/studio/project", async (req, res): Promise<void> => {
  const parsed = UpdateStudioProjectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [activeProject] = await db
    .select()
    .from(studioProjectsTable)
    .limit(1);
  if (!activeProject) {
    res.status(404).json({ error: "Studio project not found" });
    return;
  }
  const [project] = await db
    .update(studioProjectsTable)
    .set(parsed.data)
    .where(eq(studioProjectsTable.id, activeProject.id))
    .returning();

  if (!project) {
    res.status(404).json({ error: "Studio project not found" });
    return;
  }
  res.json(UpdateStudioProjectResponse.parse(project));
});

router.post("/studio/characters", async (req, res): Promise<void> => {
  const parsed = CreateStudioCharacterBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [project] = await db.select().from(studioProjectsTable).limit(1);
  if (!project) {
    res.status(404).json({ error: "Studio project not found" });
    return;
  }
  const [character] = await db
    .insert(studioCharactersTable)
    .values({ ...parsed.data, projectId: project.id })
    .returning();
  res.status(201).json(CreateStudioCharacterResponse.parse(character));
});

router.patch("/studio/characters/:id", async (req, res): Promise<void> => {
  const params = UpdateStudioCharacterParams.safeParse(req.params);
  const parsed = UpdateStudioCharacterBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [character] = await db
    .update(studioCharactersTable)
    .set(parsed.data)
    .where(eq(studioCharactersTable.id, params.data.id))
    .returning();
  if (!character) {
    res.status(404).json({ error: "Character not found" });
    return;
  }
  res.json(UpdateStudioCharacterResponse.parse(character));
});

router.post("/studio/ai/draft", async (req, res): Promise<void> => {
  const parsed = GenerateSceneDraftBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const text = await generateGeminiText(
      `You are a Christian animated action-series screenwriter. Write a screenplay-format scene draft for viewers ages 5-17. Keep the action exciting but non-graphic, make the faith lesson emerge through character choice rather than preaching, and avoid profanity, gore, and dehumanizing language.

Scene premise: ${parsed.data.premise}
Characters: ${parsed.data.characters}
Tone: ${parsed.data.tone}

Return only the screenplay scene with a scene heading, action lines, and dialogue.`,
    );
    res.json(GenerateSceneDraftResponse.parse({ text, provider: "gemini" }));
  } catch (error) {
    req.log.error({ err: error }, "Scene draft generation failed");
    res.status(502).json({ error: "Gemini could not draft this scene" });
  }
});

router.post("/studio/ai/check", async (req, res): Promise<void> => {
  const parsed = CheckSceneContentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const result = await generateGeminiJson<{
      score: number;
      label: string;
      flags: string[];
      suggestions: string[];
    }>(
      `Review this animated-series scene for viewers ages 5-17. Score 0-100 where 100 is fully appropriate. Flag profanity, graphic violence, cruelty, frightening detail, or age-inappropriate themes. Suggest replacement language or staging that keeps the action and stakes. Return JSON only with keys score, label, flags, suggestions. Scene:

${parsed.data.content}`,
    );
    res.json(CheckSceneContentResponse.parse(result));
  } catch (error) {
    req.log.error({ err: error }, "Scene content check failed");
    res.status(502).json({ error: "Gemini could not check this scene" });
  }
});

router.post("/studio/ai/director-notes", async (req, res): Promise<void> => {
  const parsed = GenerateDirectorNotesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const text = await generateGeminiText(
      `Act as a thoughtful animation director for a Christian action series for ages 5-17. Give concise, practical notes on pacing, tone, staging, actor intention, and how to make the action exciting without graphic violence. Honor the emotional beat and keep the faith lesson visible through choices.

Scene:
${parsed.data.scene}

Emotional beat:
${parsed.data.emotionalBeat}

Return notes in 4-6 short paragraphs with clear labels.`,
    );
    res.json(GenerateDirectorNotesResponse.parse({ text, provider: "gemini" }));
  } catch (error) {
    req.log.error({ err: error }, "Director note generation failed");
    res.status(502).json({ error: "Gemini could not generate director notes" });
  }
});

router.post("/studio/ai/shot-suggestions", async (req, res): Promise<void> => {
  const parsed = SuggestShotsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const result = await generateGeminiJson<
      Array<{
        shotType: string;
        movement: string;
        angle: string;
        rationale: string;
        duration: string;
      }>
    >(
      `Suggest 4 cinematic but readable animation shots for a Christian action series for ages 5-17. Keep action non-graphic and visually clear. Return a JSON array only. Each item must have shotType, movement, angle, rationale, and duration. Scene: ${parsed.data.scene}. Emotional beat: ${parsed.data.emotionalBeat}.`,
    );
    res.json(SuggestShotsResponse.parse(result));
  } catch (error) {
    req.log.error({ err: error }, "Shot suggestion generation failed");
    res.status(502).json({ error: "Gemini could not suggest shots" });
  }
});

router.post("/studio/generation/shots", async (req, res): Promise<void> => {
  const parsed = GenerateShotClipBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const generated = await submitVideoGeneration({
      prompt: parsed.data.prompt,
      referenceImageUrl: parsed.data.referenceImageUrl,
    });
    const [clip] = await db
      .insert(studioClipsTable)
      .values({
        shotId: parsed.data.shotId,
        provider: parsed.data.provider ?? generated.provider,
        status: generated.status,
        url: generated.url,
        thumbnailUrl: generated.thumbnailUrl,
        duration: generated.duration,
      })
      .returning();
    res.status(202).json(GenerateShotClipResponse.parse(clip));
  } catch (error) {
    req.log.error({ err: error }, "Shot clip generation failed");
    res.status(502).json({ error: "The configured video provider failed" });
  }
});

export default router;