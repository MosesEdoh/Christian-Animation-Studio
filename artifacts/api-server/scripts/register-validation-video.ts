import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { eq, and, isNull, asc } from "drizzle-orm";
import { db, studioClipsTable, studioShotsTable } from "@workspace/db";
import { storePrivateMedia } from "../src/lib/privateMedia";

// Imports the genuinely generated lighting study, never marks a null-URL mock
// as ready, and keeps the study separate from finished episode animation.
const [shot] = await db.select().from(studioShotsTable).orderBy(asc(studioShotsTable.id)).limit(1);
const root = fileURLToPath(new URL("../../../", import.meta.url));
if (!shot) throw new Error("No storyboard shot is available");
await db.update(studioClipsTable).set({ status: "failed" })
  .where(and(eq(studioClipsTable.provider, "mock"), isNull(studioClipsTable.url)));
await mkdir(join(root, "generated-artifacts"), { recursive: true });
for (const ratio of ["landscape", "portrait"]) for (const quality of ["720", "1080"]) {
  const label = `AI lighting study (validation) · ${ratio} ${quality}p`;
  const existing = await db.select().from(studioClipsTable).where(eq(studioClipsTable.provider, label));
  if (existing.some(clip => clip.url)) continue;
  const output = join(root, `generated-artifacts/lighting-study-${ratio}-${quality}.mp4`);
  const dimensions = ratio === "portrait" ? `${quality}:${Number(quality) * 16 / 9}` : `${Number(quality) * 16 / 9}:${quality}`;
  const [width, height] = dimensions.split(":").map(Number).map(Math.round);
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", join(root, "generated-artifacts/first-light-real-clip.mp4"),
    "-vf", `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},format=yuv420p`,
    "-c:v", "libx264", "-preset", "fast", "-crf", "21", "-threads", "2", "-movflags", "+faststart", output,
  ], { timeout: 180_000, stdio: "inherit" });
  if (result.status !== 0) throw new Error("Could not create validation video format");
  const objectPath = await storePrivateMedia(output);
  await db.insert(studioClipsTable).values({
    shotId: shot.id, provider: label, status: "ready",
    url: `/api/storage${objectPath}`, duration: "00:06", thumbnailUrl: null,
  });
}
process.stdout.write("Four real video variants saved to private App Storage. Null-URL mock clips marked failed.\n");
process.exit(0);
