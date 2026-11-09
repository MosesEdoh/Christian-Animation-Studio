import { db, studioEpisodesTable, studioExportsTable } from "@workspace/db";
import { asc } from "drizzle-orm";

const episodes = await db.select().from(studioEpisodesTable).orderBy(asc(studioEpisodesTable.number));
const existing = await db.select().from(studioExportsTable);
const queued: number[] = [];
for (const episodeId of [null, ...episodes.map(episode => episode.id)]) {
  for (const aspectRatio of ["16:9", "9:16"]) for (const quality of ["720p", "1080p"]) {
    const found = existing.find(job => job.episodeId === episodeId && job.aspectRatio === aspectRatio && job.quality === quality && job.status !== "failed");
    if (found) { queued.push(found.id); continue; }
    const [job] = await db.insert(studioExportsTable).values({ episodeId, aspectRatio, quality, status: "queued" }).returning();
    queued.push(job!.id);
  }
}
process.stdout.write(`Prepared ${queued.length} episode/series movies in both orientations and resolutions. IDs: ${queued.join(", ")}\n`);
process.exit(0);
