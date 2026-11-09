import { writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import { and, asc, eq, lt, inArray, sql } from "drizzle-orm";
import { db, createBoundedDatabase, studioExportsTable, studioProjectsTable, studioEpisodesTable, studioScenesTable, studioShotsTable, studioAssetsTable } from "@workspace/db";
import { ObjectStorageService } from "./objectStorage";
import { storePrivateMedia } from "./privateMedia";
import { logger } from "./logger";
import { movieImage, runMovieEncoder } from "./movieWork";
import { MovieBudget, MovieBudgetError, movieLimits, movieLookup, movieOperation, smallerMovie } from "./movieBudget";
import { MovieTemporaryStorage, MOVIE_RENDER_LEASE_MS } from "./movieTemporaryStorage";
import { wrapMovieText as wrap, movieScenePages, moviePageSeconds } from "./movieLayout";

export const movieDb = createBoundedDatabase();
const temporaryStorage = new MovieTemporaryStorage();
let recoveryTimer: NodeJS.Timeout | undefined;

export function startMovieTemporaryRecovery() {
  if (recoveryTimer || stopping) return;
  const recover = async () => {
    try {
      const removed = await temporaryStorage.recover((err, directory) => {
        logger.warn({ err, directory }, "Could not recover temporary movie directory");
      });
      if (removed) logger.info({ removed }, "Recovered abandoned temporary movie directories");
    } catch (err) {
      logger.warn({ err }, "Could not scan temporary movie directories");
    }
  };
  void recover();
  recoveryTimer = setInterval(() => { void recover(); }, 5 * 60_000);
  recoveryTimer.unref();
}

type ExportRow = typeof studioExportsTable.$inferSelect;
let stopping = false;
let activeController: AbortController | null = null;
let activeRender: Promise<void> | null = null;
let activeJobId: number | null = null;
const renderingJob = (id: number) => and(eq(studioExportsTable.id, id), eq(studioExportsTable.status, "rendering"));
const cancelledError = () => new Error("Storyboard movie cancelled");

export async function cancelMovieExport(id: number) {
  // The status comparison arbitrates completion/cancellation races atomically.
  const [cancelled] = await db.update(studioExportsTable)
    .set({ status: "cancelled", progress: 0, error: null, objectPath: null, sizeBytes: null, startedAt: null })
    .where(and(eq(studioExportsTable.id, id), inArray(studioExportsTable.status, ["queued", "rendering"]))).returning();
  if (cancelled && activeJobId === id) activeController?.abort(cancelledError());
  if (cancelled) return cancelled;
  const [existing] = await db.select().from(studioExportsTable).where(eq(studioExportsTable.id, id));
  return existing;
}
export const exportView = (row: ExportRow) => ({
  ...row, url: row.status === "ready" && row.objectPath ? `/api/studio/exports/${row.id}/file` : null,
});
const xml = (value: string) => value.replace(/[<>&"']/g, char => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[char]!));

async function render(row: ExportRow, budget: MovieBudget) {
  const signal = budget.signal;
  signal.throwIfAborted();
  const directory = await temporaryStorage.create();
  let uploadedPath: string | null = null;
  try {
    signal.throwIfAborted();
    const [project] = await movieLookup(movieDb.select().from(studioProjectsTable).limit(1), signal);
    const episodes = await movieLookup(movieDb.select().from(studioEpisodesTable)
      .where(row.episodeId ? eq(studioEpisodesTable.id, row.episodeId) : undefined)
      .orderBy(asc(studioEpisodesTable.number)).limit(movieLimits.frames + 1), signal);
    const selected = row.episodeId ? episodes.filter(episode => episode.id === row.episodeId) : episodes;
    if (!project || !selected.length) throw new Error("Episode not found");
    budget.checkFrames(selected.length + 1);
    const scenes = await movieLookup(movieDb.select().from(studioScenesTable)
      .where(inArray(studioScenesTable.episodeId, selected.map(episode => episode.id)))
      .orderBy(asc(studioScenesTable.number)).limit(movieLimits.frames + 1), signal);
    budget.checkFrames(selected.length + scenes.length + 1);
    const sceneIds = scenes.map(scene => scene.id);
    const shots = sceneIds.length ? await movieLookup(movieDb.select().from(studioShotsTable)
      .where(inArray(studioShotsTable.sceneId, sceneIds)).orderBy(asc(studioShotsTable.number)).limit(20_001), signal) : [];
    const assets = sceneIds.length ? await movieLookup(movieDb.select().from(studioAssetsTable)
      .where(inArray(studioAssetsTable.sceneId, sceneIds)).orderBy(asc(studioAssetsTable.id)).limit(20_001), signal) : [];
    if (shots.length > 20_000 || assets.length > 20_000) throw new MovieBudgetError(`Movie has too many shots or references. ${smallerMovie}`);
    const portrait = row.aspectRatio === "9:16";
    const width = portrait ? 720 : 1280;
    const height = portrait ? 1280 : 720;
    const scale = row.quality === "1080p" ? 1.5 : 1;
    const frames: { label: string; title: string; lines: string[]; image: string | null; seconds: number; shot: string }[] = [];
    for (const episode of selected) {
      signal.throwIfAborted();
      budget.checkFrames(frames.length + 2);
      frames.push({ label: project.title, title: `Episode ${episode.number}: ${episode.title}`, lines: wrap(episode.summary, portrait ? 45 : 43, portrait ? 18 : 13), image: null, seconds: 6, shot: "Silent storyboard movie · review edition" });
      const episodeScenes = scenes.filter(scene => scene.episodeId === episode.id);
      if (!episodeScenes.length) throw new Error("Complete the episode script first");
      for (const scene of episodeScenes) {
        signal.throwIfAborted();
        const sceneShots = shots.filter(shot => shot.sceneId === scene.id);
        const { lines, pageSize, pageCount } = movieScenePages(scene, portrait);
        budget.checkFrames(frames.length + pageCount + 1);
        for (let page = 0; page < pageCount; page++) {
          const shot = sceneShots[Math.min(sceneShots.length - 1, Math.floor(page * sceneShots.length / pageCount))];
          const reference = shot?.referenceImageUrl ?? assets.filter(asset => asset.sceneId === scene.id && asset.kind === "storyboard").at(-1)?.objectPath ?? null;
          const pageLines = lines.slice(page * pageSize, (page + 1) * pageSize);
          frames.push({
            label: `EPISODE ${episode.number} · SCENE ${scene.number} · CARD ${page + 1}/${pageCount}`,
            title: scene.heading,
            lines: pageLines, image: reference?.startsWith("/objects/") ? reference : null,
            seconds: moviePageSeconds(scene.duration, pageCount, pageLines),
            shot: shot ? `${shot.shotType} · ${shot.movement} · ${shot.beat}` : scene.synopsis,
          });
        }
      }
    }
    frames.push({ label: project.title, title: "End of storyboard movie", lines: ["A review animatic made from your saved scripts", "and reference images.", "", "Not final animation. No recorded dialogue.", "Review Bible references and age suitability", "before sharing with children."], image: null, seconds: 7, shot: "Frame & Faith · private studio" });
    const totalDuration = frames.reduce((sum, frame) => sum + frame.seconds, 0);
    budget.checkDuration(totalDuration);
    const storage = new ObjectStorageService();
    const images = new Map<string, Buffer>();
    const concat: string[] = [];
    let duration = 0;
    for (const [index, frame] of frames.entries()) {
      signal.throwIfAborted();
      const imageBox = portrait ? { left: 35, top: 166, width: 650, height: 365 } : { left: 35, top: 158, width: 570, height: 430 };
      const textLeft = portrait ? 40 : 650;
      const textTop = portrait ? 580 : 183;
      const lineHeight = portrait ? 30 : 29;
      const titleLines = wrap(frame.title, portrait ? 40 : 62).slice(0, 2);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width * scale}" height="${height * scale}" viewBox="0 0 ${width} ${height}">
        <rect width="100%" height="100%" fill="#f4f0e8"/>
        <rect width="${width}" height="38" fill="#242338"/>
        <text x="35" y="25" fill="#f2cf51" font-family="DejaVu Sans" font-size="15">SILENT STORYBOARD MOVIE · NOT FINAL ANIMATION</text>
        <text x="35" y="72" fill="#478f8b" font-family="DejaVu Sans" font-size="16">${xml(frame.label)}</text>
        ${titleLines.map((line, i) => `<text x="35" y="${111 + i * 29}" fill="#242338" font-family="DejaVu Sans" font-weight="bold" font-size="25">${xml(line)}</text>`).join("")}
        <rect x="${imageBox.left}" y="${imageBox.top}" width="${imageBox.width}" height="${imageBox.height}" rx="12" fill="#242338"/>
        <circle cx="${imageBox.left + imageBox.width / 2}" cy="${imageBox.top + imageBox.height / 2 - 20}" r="45" fill="#f2cf51"/>
        <text x="${imageBox.left + 25}" y="${imageBox.top + imageBox.height - 40}" fill="#f4f0e8" font-family="DejaVu Sans" font-size="16">No uploaded storyboard reference</text>
        ${frame.lines.map((line, i) => `<text x="${textLeft}" y="${textTop + i * lineHeight}" fill="#242338" font-family="DejaVu Sans" font-size="${portrait ? 25 : 23}">${xml(line)}</text>`).join("")}
        ${wrap(frame.shot, portrait ? 55 : 115).slice(0, 2).map((line, i) => `<text x="35" y="${height - 66 + i * 22}" fill="#686879" font-family="DejaVu Sans" font-size="16">${xml(line)}</text>`).join("")}
        <text x="35" y="${height - 16}" fill="#478f8b" font-family="DejaVu Sans" font-size="13">FRAME &amp; FAITH · ${index + 1} / ${frames.length} · ${row.quality} ${row.aspectRatio}</text>
      </svg>`;
      const overlays: OverlayOptions[] = [];
      if (frame.image) {
        if (!images.has(frame.image)) {
          const file = await movieLookup(storage.getObjectEntityFile(frame.image), signal);
          signal.throwIfAborted();
          images.set(frame.image, await budget.reference(file.createReadStream()));
        }
        const image = sharp(images.get(frame.image)!, { limitInputPixels: 16_777_216 }).rotate().resize(Math.round(imageBox.width * scale), Math.round(imageBox.height * scale), { fit: "contain", background: "#242338" }).png();
        const input = await movieImage(image.timeout({ seconds: budget.remainingSeconds }), () => image.toBuffer(), signal);
        overlays.push({ input, left: Math.round(imageBox.left * scale), top: Math.round(imageBox.top * scale) });
      }
      const filename = `frame-${String(index).padStart(5, "0")}.png`;
      const image = sharp(Buffer.from(svg)).composite(overlays).png();
      const png = await movieImage(image.timeout({ seconds: budget.remainingSeconds }), () => image.toBuffer(), signal);
      budget.addTemporary(png.length);
      await writeFile(join(directory, filename), png, { signal });
      concat.push(`file '${filename}'`, `duration ${frame.seconds.toFixed(3)}`);
      duration += frame.seconds;
      if (index % 6 === 0) await movieOperation(movieDb.update(studioExportsTable).set({ progress: Math.round((index + 1) / frames.length * 45) }).where(renderingJob(row.id)), signal);
    }
    concat.push(`file 'frame-${String(frames.length - 1).padStart(5, "0")}.png'`);
    const manifest = concat.join("\n");
    budget.addTemporary(Buffer.byteLength(manifest));
    await writeFile(join(directory, "frames.txt"), manifest, { signal });
    const output = join(directory, "movie.mp4");
    signal.throwIfAborted();
    await movieOperation(movieDb.update(studioExportsTable).set({ progress: 50 }).where(renderingJob(row.id)), signal);
    signal.throwIfAborted();
    // FFmpeg may exceed -fs by one muxed packet. Reserve 16 MiB (more than a
    // raw 1080p RGBA frame) and reject size-limited output, never publish a cut movie.
    const outputLimit = budget.remainingTemporaryBytes - 16 * 1024 * 1024;
    if (outputLimit <= 0) throw budget.diskError();
    await runMovieEncoder([
        "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", join(directory, "frames.txt"),
        "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
        "-t", duration.toFixed(3), "-vf", "fps=2,format=yuv420p", "-c:v", "libx264", "-preset", "ultrafast",
        "-crf", "23", "-threads", "2", "-c:a", "aac", "-b:a", "32k", "-movflags", "+faststart",
        "-fs", String(outputLimit),
        "-metadata", "title=Frame & Faith — Silent storyboard review movie", output,
      ], signal);
    signal.throwIfAborted();
    const outputSize = (await stat(output)).size;
    if (outputSize >= outputLimit) throw budget.diskError();
    budget.addTemporary(outputSize);
    await movieOperation(movieDb.update(studioExportsTable).set({ progress: 90 }).where(renderingJob(row.id)), signal);
    // Upload cancellation closes the pipeline; do not let remote best-effort
    // deletion after an aborted upload hold the render worker indefinitely.
    uploadedPath = await movieLookup(storePrivateMedia(output, "mp4", "video/mp4", signal), signal);
    signal.throwIfAborted();
    const path = uploadedPath;
    let abandoned = false;
    const completion = Promise.resolve(movieDb.update(studioExportsTable)
      .set({ status: "ready", progress: 100, objectPath: path, sizeBytes: outputSize, error: null })
      .where(and(renderingJob(row.id), sql`clock_timestamp() < ${budget.expiresAt}`)).returning())
      .then(async saved => {
        // A query may commit before its response arrives. If our wait was
        // abandoned, compensate even if the normal failure write ran earlier.
        if (saved.length && (abandoned || signal.aborted)) {
          await movieOperation(movieDb.update(studioExportsTable)
            .set({ status: "failed", progress: 0, objectPath: null, sizeBytes: null, startedAt: null,
              error: "Saving the movie exceeded its deadline. Try building it again." })
            .where(and(eq(studioExportsTable.id, row.id), eq(studioExportsTable.status, "ready"), eq(studioExportsTable.objectPath, path))));
        }
        return saved;
      });
    let saved: ExportRow | undefined;
    try { [saved] = await movieOperation(completion, signal); }
    catch (error) { abandoned = true; throw error; }
    if (!saved && Date.now() >= budget.expiresAt.getTime()) {
      throw new MovieBudgetError(`Saving the movie exceeded its render deadline. ${smallerMovie}`);
    }
    if (saved) uploadedPath = null;
  } finally {
    try {
      if (uploadedPath) {
        const file = await movieOperation(new ObjectStorageService().getObjectEntityFile(uploadedPath));
        await movieOperation(file.delete({ ignoreNotFound: true }));
      }
    } finally { await temporaryStorage.remove(directory); }
  }
}

let running = false;
export async function wakeMovieWorker() {
  if (running || stopping) return;
  running = true;
  try {
    // The whole render has a twenty-minute budget, below the recovery lease.
    await movieOperation(movieDb.update(studioExportsTable).set({ status: "queued", progress: 0 })
      .where(and(eq(studioExportsTable.status, "rendering"), lt(studioExportsTable.startedAt, new Date(Date.now() - MOVIE_RENDER_LEASE_MS)))));
    while (!stopping) {
      const [candidate] = await movieOperation(movieDb.select().from(studioExportsTable).where(eq(studioExportsTable.status, "queued")).orderBy(asc(studioExportsTable.id)).limit(1));
      if (!candidate) break;
      const [job] = await movieOperation(movieDb.update(studioExportsTable).set({ status: "rendering", startedAt: new Date(), error: null })
        .where(and(eq(studioExportsTable.id, candidate.id), eq(studioExportsTable.status, "queued"))).returning());
      if (!job) continue;
      activeJobId = job.id;
      const controller = new AbortController();
      activeController = controller;
      const budget = new MovieBudget(controller.signal);
      // Also observe cancellation accepted by another server process.
      let checking = false;
      const checkCancellation = async () => {
        if (checking || controller.signal.aborted) return;
        checking = true;
        try {
          const [current] = await movieOperation(movieDb.select().from(studioExportsTable).where(eq(studioExportsTable.id, job.id)), budget.signal);
          if (!current || current.status !== "rendering") controller.abort(cancelledError());
        } catch (error) {
          logger.warn({ err: error, exportId: job.id }, "Could not check movie cancellation");
        } finally { checking = false; }
      };
      const poll = setInterval(() => { void checkCancellation(); }, 500);
      try {
        activeRender = (async () => {
          await movieLookup(checkCancellation(), budget.signal);
          await render(job, budget);
        })();
        await activeRender;
      }
      catch (error) {
        if (!stopping && !controller.signal.aborted) logger.error({ err: error, exportId: job.id }, "Storyboard movie failed");
        try { await movieOperation(movieDb.update(studioExportsTable).set(stopping
          ? { status: "queued", progress: 0, startedAt: null, error: null }
          : { status: "failed", progress: 0, startedAt: null, error:
            (budget.signal.aborted ? budget.signal.reason : error) instanceof MovieBudgetError
              ? ((budget.signal.aborted ? budget.signal.reason : error) as MovieBudgetError).message
              : "Movie could not be built. Check references and try building again.", objectPath: null, sizeBytes: null })
          .where(and(eq(studioExportsTable.id, job.id), eq(studioExportsTable.startedAt, job.startedAt!),
            inArray(studioExportsTable.status, ["rendering", "ready"]))));
        } catch (statusError) {
          logger.error({ err: statusError, exportId: job.id }, "Could not save failed movie status; recovery lease will retry it");
        }
      }
      finally { budget.dispose(); clearInterval(poll); activeController = null; activeRender = null; activeJobId = null; }
    }
  } catch (error) { logger.error({ err: error }, "Movie worker failed"); }
  finally { running = false; }
}

export async function stopMovieWorker() {
  stopping = true;
  clearInterval(recoveryTimer);
  recoveryTimer = undefined;
  const jobId = activeJobId;
  activeController?.abort(new Error("Studio server is restarting"));
  await activeRender?.catch(() => {});
  if (jobId) await movieOperation(movieDb.update(studioExportsTable).set({ status: "queued", progress: 0, startedAt: null })
    .where(and(eq(studioExportsTable.id, jobId), eq(studioExportsTable.status, "rendering"))));
}
