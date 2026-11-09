import { asc, eq, inArray, sql } from "drizzle-orm";
import { createBoundedDatabase, studioEpisodesTable, studioScenesTable } from "@workspace/db";
import { MovieBudgetError, movieLimits, movieLookup } from "./movieBudget";
import { moviePageSeconds, movieScenePages, wrapMovieText } from "./movieLayout";

export const preflightDb = createBoundedDatabase();
const textBudget = movieLimits.frames * 18 * 48;
const scriptBatchSize = 100;
const scriptText = sql`coalesce(nullif(${studioScenesTable.content}, ''), ${studioScenesTable.synopsis})`;
const scriptLength = sql<number>`least(length(${scriptText}), ${textBudget + 1})`;

export async function estimateMovie(episodeId: number | undefined, aspectRatio: "16:9" | "9:16") {
  const signal = AbortSignal.timeout(5000);
  const portrait = aspectRatio === "9:16";
  const scope = episodeId === undefined ? "Entire series" : "This episode";
  const suggestion = episodeId === undefined
    ? "Choose an episode and export episodes separately."
    : "Shorten this episode's saved script or scene durations and check again.";
  const result = (canQueue: boolean, message: string, cards: number | null = null, playbackSeconds: number | null = null) => ({
    canQueue, message, cards, playbackSeconds,
    cardLimit: movieLimits.frames, playbackLimitSeconds: movieLimits.playbackSeconds,
  });
  const blocked = (reason: string) => result(false, `${scope}: ${reason} ${suggestion} Nothing will be split or shortened automatically.`);
  const episodes = await movieLookup(preflightDb.select({
    id: studioEpisodesTable.id,
    summary: sql<string>`left(${studioEpisodesTable.summary}, 850)`,
  }).from(studioEpisodesTable)
    .where(episodeId === undefined ? undefined : eq(studioEpisodesTable.id, episodeId))
    .orderBy(asc(studioEpisodesTable.number)).limit(movieLimits.frames + 1), signal);
  if (!episodes.length) return null;
  if (episodes.length + 1 > movieLimits.frames) return blocked(`exceeds the ${movieLimits.frames} storyboard card limit.`);
  const scenes = await movieLookup(preflightDb.select({
    id: studioScenesTable.id, episodeId: studioScenesTable.episodeId,
    duration: studioScenesTable.duration,
    scriptLength,
  }).from(studioScenesTable).where(inArray(studioScenesTable.episodeId, episodes.map(episode => episode.id)))
    .orderBy(asc(studioScenesTable.number)).limit(movieLimits.frames + 1), signal);
  if (episodes.length + scenes.length + 1 > movieLimits.frames) return blocked(`exceeds the ${movieLimits.frames} storyboard card limit.`);
  if (episodes.some(episode => !scenes.some(scene => scene.episodeId === episode.id))) {
    return result(false, `${scope}: complete each selected episode's script before building a movie.`);
  }
  let cards = episodes.length + 1;
  let playback = episodes.length * 6 + 7;
  let remainingText = textBudget;
  try {
    for (const episode of episodes) wrapMovieText(episode.summary, portrait ? 45 : 43, portrait ? 18 : 13);
    // Measure before fetching text, so per-row caps sum to at most textBudget
    // across ALL batches, not textBudget per scene. Caps also prevent concurrent
    // edits from expanding a batch; changed lengths require a fresh estimate.
    if (scenes.reduce((total, scene) => total + scene.scriptLength, 0) > textBudget) {
      return blocked("saved script text exceeds the bounded movie estimate.");
    }
    // Fetch only scripts, never reference files. Keep both the row bound and the
    // single overall database deadline while avoiding one round trip per scene.
    for (let offset = 0; offset < scenes.length; offset += scriptBatchSize) {
      signal.throwIfAborted();
      const batch = scenes.slice(offset, offset + scriptBatchSize);
      const cap = sql`case ${studioScenesTable.id} ${sql.join(batch.map(scene =>
        sql`when ${scene.id} then ${scene.scriptLength}`,
      ), sql` `)} else 0 end`;
      const savedScripts = await movieLookup(preflightDb.select({
        id: studioScenesTable.id,
        scriptLength,
        text: sql<string>`left(${scriptText}, ${cap})`,
      }).from(studioScenesTable).where(inArray(studioScenesTable.id, batch.map(scene => scene.id)))
        .limit(batch.length), signal);
      const scriptsById = new Map(savedScripts.map(saved => [saved.id, saved]));
      for (const scene of batch) {
        signal.throwIfAborted();
        const saved = scriptsById.get(scene.id);
        if (!saved || saved.scriptLength !== scene.scriptLength) {
          return result(false, "The script changed during the estimate. Check again.");
        }
        // PostgreSQL counts code points; retain the stricter JS text accounting
        // used by movie layout (including surrogate pairs).
        remainingText -= saved.text.length;
        if (remainingText < 0) return blocked("saved script text exceeds the bounded movie estimate.");
        const { lines, pageCount, pageSize } = movieScenePages({ content: saved.text, synopsis: "" }, portrait);
        cards += pageCount;
        if (cards > movieLimits.frames) return blocked(`exceeds the ${movieLimits.frames} storyboard card limit.`);
        for (let page = 0; page < pageCount; page++) {
          playback += moviePageSeconds(scene.duration, pageCount, lines.slice(page * pageSize, (page + 1) * pageSize));
        }
        if (!Number.isFinite(playback) || playback > movieLimits.playbackSeconds) return blocked("exceeds the 6 hour playback limit or has an invalid scene duration.");
      }
    }
    return result(true, `${scope} fits the card and playback limits for the saved scripts.`, cards, playback);
  } catch (error) {
    if (error instanceof MovieBudgetError) return blocked(error.message);
    throw error;
  }
}
