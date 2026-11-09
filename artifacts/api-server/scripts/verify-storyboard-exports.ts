import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { db, studioExportsTable, studioEpisodesTable } from "@workspace/db";
import { ObjectStorageService } from "../src/lib/objectStorage";

const outputDir = fileURLToPath(new URL("../../../generated-artifacts/", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "verify-movies-"));
const storage = new ObjectStorageService();
try {
  const jobs = await db.select().from(studioExportsTable);
  const episodes = await db.select().from(studioEpisodesTable);
  const report: object[] = [];
  for (const episodeId of [null, ...episodes.map(episode => episode.id)]) {
    for (const aspectRatio of ["16:9", "9:16"]) for (const quality of ["720p", "1080p"]) {
      const job = jobs.find(row => row.episodeId === episodeId && row.aspectRatio === aspectRatio && row.quality === quality && row.status === "ready");
      if (!job?.objectPath) throw new Error(`Missing ready movie: ${episodeId ?? "series"} ${aspectRatio} ${quality}`);
      const file = await storage.getObjectEntityFile(job.objectPath);
      const localPath = join(directory, `${job.id}.mp4`);
      await file.download({ destination: localPath });
      const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration,size:stream=codec_name,width,height", "-of", "json", localPath], { encoding: "utf8" });
      if (probe.status !== 0) throw new Error(`Movie #${job.id} is not a readable MP4`);
      const parsed = JSON.parse(probe.stdout);
      const video = parsed.streams.find((stream: { width?: number }) => stream.width);
      const short = quality === "720p" ? 720 : 1080;
      const expected = aspectRatio === "16:9" ? [short * 16 / 9, short] : [short, short * 16 / 9];
      const duration = Number(parsed.format.duration);
      if (video.codec_name !== "h264" || video.width !== expected[0] || video.height !== expected[1] || duration < (episodeId ? 60 : 300)) {
        throw new Error(`Movie #${job.id} has incorrect format or an incomplete duration`);
      }
      report.push({ id: job.id, episodeId, aspectRatio, quality, durationSeconds: duration, bytes: Number(parsed.format.size), width: video.width, height: video.height, codec: video.codec_name });
      if (episodeId === episodes[0]?.id && quality === "720p") {
        await mkdir(outputDir, { recursive: true });
        const screenshot = spawnSync("ffmpeg", ["-v", "error", "-y", "-ss", "30", "-i", localPath, "-frames:v", "1", join(outputDir, aspectRatio === "16:9" ? "movie-frame-landscape.png" : "movie-frame-portrait.png")], { timeout: 30_000 });
        if (screenshot.status !== 0) throw new Error("Could not decode storyboard movie frame");
      }
    }
  }
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, "movie-verification.json"), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} finally { await rm(directory, { recursive: true, force: true }); }
process.exit(0);
