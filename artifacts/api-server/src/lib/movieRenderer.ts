import { addAbortSignal } from "node:stream";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import { and, asc, eq, lt, inArray } from "drizzle-orm";
import { db, studioExportsTable, studioProjectsTable, studioEpisodesTable, studioScenesTable, studioShotsTable, studioAssetsTable } from "@workspace/db";
import { ObjectStorageService } from "./objectStorage";
import { storePrivateMedia } from "./privateMedia";
import { logger } from "./logger";
import { movieImage, runMovieEncoder } from "./movieWork";

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
    .set({ status: "cancelled", progress: 0, error: null, objectPath: null, startedAt: null })
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
function wrap(text: string, width: number) {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r/g, "").split("\n")) {
    if (!paragraph.trim()) { lines.push(""); continue; }
    let line = "";
    for (let word of paragraph.split(/\s+/)) {
      while (word.length > width) {
        if (line) { lines.push(line); line = ""; }
        lines.push(word.slice(0, width)); word = word.slice(width);
      }
      if (line && `${line} ${word}`.length > width) { lines.push(line); line = word; }
      else line = line ? `${line} ${word}` : word;
    }
    if (line) lines.push(line);
  }
  return lines;
}
const seconds = (duration: string) => duration.split(":").reduce((total, part) => total * 60 + Number(part), 0) || 60;

async function render(row: ExportRow, signal: AbortSignal) {
  signal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "faith-movie-"));
  let uploadedPath: string | null = null;
  try {
    signal.throwIfAborted();
    const [project] = await db.select().from(studioProjectsTable).limit(1);
    const episodes = await db.select().from(studioEpisodesTable).orderBy(asc(studioEpisodesTable.number));
    const selected = row.episodeId ? episodes.filter(episode => episode.id === row.episodeId) : episodes;
    if (!project || !selected.length) throw new Error("Episode not found");
    const scenes = await db.select().from(studioScenesTable).orderBy(asc(studioScenesTable.number));
    const shots = await db.select().from(studioShotsTable).orderBy(asc(studioShotsTable.number));
    const assets = await db.select().from(studioAssetsTable).orderBy(asc(studioAssetsTable.id));
    const portrait = row.aspectRatio === "9:16";
    const width = portrait ? 720 : 1280;
    const height = portrait ? 1280 : 720;
    const scale = row.quality === "1080p" ? 1.5 : 1;
    const frames: { label: string; title: string; lines: string[]; image: string | null; seconds: number; shot: string }[] = [];
    for (const episode of selected) {
      signal.throwIfAborted();
      frames.push({ label: project.title, title: `Episode ${episode.number}: ${episode.title}`, lines: wrap(episode.summary, portrait ? 45 : 43), image: null, seconds: 6, shot: "Silent storyboard movie · review edition" });
      const episodeScenes = scenes.filter(scene => scene.episodeId === episode.id);
      if (!episodeScenes.length) throw new Error("Complete the episode script first");
      for (const scene of episodeScenes) {
        signal.throwIfAborted();
        const sceneShots = shots.filter(shot => shot.sceneId === scene.id);
        const lines = wrap(scene.content || scene.synopsis, portrait ? 46 : 43);
        const pageSize = portrait ? 18 : 13;
        const pageCount = Math.max(1, Math.ceil(lines.length / pageSize));
        for (let page = 0; page < pageCount; page++) {
          const shot = sceneShots[Math.min(sceneShots.length - 1, Math.floor(page * sceneShots.length / pageCount))];
          const reference = shot?.referenceImageUrl ?? assets.filter(asset => asset.sceneId === scene.id && asset.kind === "storyboard").at(-1)?.objectPath ?? null;
          const pageLines = lines.slice(page * pageSize, (page + 1) * pageSize);
          frames.push({
            label: `EPISODE ${episode.number} · SCENE ${scene.number} · CARD ${page + 1}/${pageCount}`,
            title: scene.heading,
            lines: pageLines, image: reference?.startsWith("/objects/") ? reference : null,
            seconds: Math.max(seconds(scene.duration) / pageCount, pageLines.join(" ").length / 15, 5),
            shot: shot ? `${shot.shotType} · ${shot.movement} · ${shot.beat}` : scene.synopsis,
          });
        }
      }
    }
    frames.push({ label: project.title, title: "End of storyboard movie", lines: ["A review animatic made from your saved scripts", "and reference images.", "", "Not final animation. No recorded dialogue.", "Review Bible references and age suitability", "before sharing with children."], image: null, seconds: 7, shot: "Frame & Faith · private studio" });
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
          const file = await storage.getObjectEntityFile(frame.image);
          signal.throwIfAborted();
          const chunks: Buffer[] = [];
          for await (const chunk of addAbortSignal(signal, file.createReadStream())) {
            chunks.push(Buffer.from(chunk));
          }
          images.set(frame.image, Buffer.concat(chunks));
        }
        const image = sharp(images.get(frame.image)!).rotate().resize(Math.round(imageBox.width * scale), Math.round(imageBox.height * scale), { fit: "contain", background: "#242338" }).png();
        const input = await movieImage(image, () => image.toBuffer(), signal);
        overlays.push({ input, left: Math.round(imageBox.left * scale), top: Math.round(imageBox.top * scale) });
      }
      const filename = `frame-${String(index).padStart(5, "0")}.png`;
      const image = sharp(Buffer.from(svg)).composite(overlays).png();
      await movieImage(image, () => image.toFile(join(directory, filename)), signal);
      concat.push(`file '${filename}'`, `duration ${frame.seconds.toFixed(3)}`);
      duration += frame.seconds;
      if (index % 6 === 0) await db.update(studioExportsTable).set({ progress: Math.round((index + 1) / frames.length * 45) }).where(renderingJob(row.id));
    }
    concat.push(`file 'frame-${String(frames.length - 1).padStart(5, "0")}.png'`);
    await writeFile(join(directory, "frames.txt"), concat.join("\n"));
    const output = join(directory, "movie.mp4");
    signal.throwIfAborted();
    await db.update(studioExportsTable).set({ progress: 50 }).where(renderingJob(row.id));
    signal.throwIfAborted();
    await runMovieEncoder([
        "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", join(directory, "frames.txt"),
        "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
        "-t", duration.toFixed(3), "-vf", "fps=2,format=yuv420p", "-c:v", "libx264", "-preset", "ultrafast",
        "-crf", "23", "-threads", "2", "-c:a", "aac", "-b:a", "32k", "-movflags", "+faststart",
        "-metadata", "title=Frame & Faith — Silent storyboard review movie", output,
      ], signal);
    signal.throwIfAborted();
    await db.update(studioExportsTable).set({ progress: 90 }).where(renderingJob(row.id));
    uploadedPath = await storePrivateMedia(output, "mp4", "video/mp4", signal);
    signal.throwIfAborted();
    const [saved] = await db.update(studioExportsTable).set({ status: "ready", progress: 100, objectPath: uploadedPath, error: null }).where(renderingJob(row.id)).returning();
    if (saved) uploadedPath = null;
  } finally {
    try {
      if (uploadedPath) {
        const file = await new ObjectStorageService().getObjectEntityFile(uploadedPath);
        await file.delete({ ignoreNotFound: true });
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}

let running = false;
export async function wakeMovieWorker() {
  if (running || stopping) return;
  running = true;
  try {
    // A crashed process cannot hold a job indefinitely; active renders have a
    // twenty-minute timeout, so a thirty-minute lease can safely be retried.
    await db.update(studioExportsTable).set({ status: "queued", progress: 0 })
      .where(and(eq(studioExportsTable.status, "rendering"), lt(studioExportsTable.startedAt, new Date(Date.now() - 30 * 60_000))));
    while (!stopping) {
      const [candidate] = await db.select().from(studioExportsTable).where(eq(studioExportsTable.status, "queued")).orderBy(asc(studioExportsTable.id)).limit(1);
      if (!candidate) break;
      const [job] = await db.update(studioExportsTable).set({ status: "rendering", startedAt: new Date(), error: null })
        .where(and(eq(studioExportsTable.id, candidate.id), eq(studioExportsTable.status, "queued"))).returning();
      if (!job) continue;
      activeJobId = job.id;
      const controller = new AbortController();
      activeController = controller;
      // Also observe cancellation accepted by another server process.
      let checking = false;
      const checkCancellation = async () => {
        if (checking || controller.signal.aborted) return;
        checking = true;
        try {
          const [current] = await db.select().from(studioExportsTable).where(eq(studioExportsTable.id, job.id));
          if (!current || current.status !== "rendering") controller.abort(cancelledError());
        } catch (error) {
          logger.warn({ err: error, exportId: job.id }, "Could not check movie cancellation");
        } finally { checking = false; }
      };
      const poll = setInterval(() => { void checkCancellation(); }, 500);
      try {
        activeRender = (async () => {
          await checkCancellation();
          await render(job, controller.signal);
        })();
        await activeRender;
      }
      catch (error) {
        if (!stopping && !controller.signal.aborted) logger.error({ err: error, exportId: job.id }, "Storyboard movie failed");
        await db.update(studioExportsTable).set(stopping
          ? { status: "queued", progress: 0, startedAt: null, error: null }
          : { status: "failed", error: "Movie could not be built. Check references and try building again." }).where(renderingJob(job.id));
      }
      finally { clearInterval(poll); activeController = null; activeRender = null; activeJobId = null; }
    }
  } catch (error) { logger.error({ err: error }, "Movie worker failed"); }
  finally { running = false; }
}

export async function stopMovieWorker() {
  stopping = true;
  const jobId = activeJobId;
  activeController?.abort(new Error("Studio server is restarting"));
  await activeRender?.catch(() => {});
  if (jobId) await db.update(studioExportsTable).set({ status: "queued", progress: 0, startedAt: null })
    .where(and(eq(studioExportsTable.id, jobId), eq(studioExportsTable.status, "rendering")));
}
