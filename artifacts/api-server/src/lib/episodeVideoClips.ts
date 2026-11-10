import { asc, eq } from "drizzle-orm";
import { db, studioClipsTable, studioShotsTable, studioScenesTable } from "@workspace/db";

// Keep this query shared by the route and its SQL-order regression test.
export function episodeVideoClipsQuery(episodeId: number) {
  return db
    .select({ clip: studioClipsTable, sceneId: studioScenesTable.id })
    .from(studioClipsTable)
    .innerJoin(studioShotsTable, eq(studioClipsTable.shotId, studioShotsTable.id))
    .innerJoin(studioScenesTable, eq(studioShotsTable.sceneId, studioScenesTable.id))
    .where(eq(studioScenesTable.episodeId, episodeId))
    .orderBy(
      asc(studioScenesTable.number),
      asc(studioShotsTable.number),
      asc(studioClipsTable.createdAt),
      asc(studioClipsTable.id),
    );
}
