import { Router } from "express";
import { and, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { db, studioExportsTable, studioEpisodesTable } from "@workspace/db";
import { CreateStudioExportBody, CreateStudioExportResponse, ListStudioExportsQueryParams, ListStudioExportsResponse, DownloadStudioExportParams, CancelStudioExportParams, CancelStudioExportResponse, DeleteStudioExportParams } from "@workspace/api-zod";
import { cancelMovieExport, exportView, wakeMovieWorker } from "../lib/movieRenderer";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";
import { streamPrivateMedia } from "../lib/privateMedia";
import { GetStudioExportStorageResponse, PreflightStudioExportQueryParams, PreflightStudioExportResponse } from "@workspace/api-zod";
import { estimateMovie } from "../lib/moviePreflight";

const router = Router();
router.get("/studio/exports/storage", async (_req, res): Promise<void> => {
  // The parent /studio guard is identical to history and deletion. Aggregate in
  // the database, never over a limited page or by loading all history into RAM.
  const knownSize = sql`${studioExportsTable.sizeBytes} between 0 and 9007199254740991`;
  const [summary] = await db.select({
    knownSizeBytes: sql`coalesce(sum(${studioExportsTable.sizeBytes}) filter (where ${knownSize}), 0)`.mapWith(Number),
    savedMovieCount: sql`count(*)`.mapWith(Number),
    unknownSizeCount: sql`count(*) filter (where ${studioExportsTable.sizeBytes} is null or not (${knownSize}))`.mapWith(Number),
  }).from(studioExportsTable).where(and(
    eq(studioExportsTable.status, "ready"), isNotNull(studioExportsTable.objectPath),
  ));
  res.json(GetStudioExportStorageResponse.parse(summary));
});
router.get("/studio/exports/preflight", async (req, res): Promise<void> => {
  const parsed = PreflightStudioExportQueryParams.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Choose a valid episode and orientation." }); return; }
  try {
    const estimate = await estimateMovie(parsed.data.episodeId, parsed.data.aspectRatio);
    if (!estimate) { res.status(404).json({ error: "Episode not found" }); return; }
    res.json(PreflightStudioExportResponse.parse(estimate));
  } catch (error) {
    req.log.warn({ err: error }, "Movie estimate unavailable");
    res.status(503).json({ error: "Could not check movie limits. Please try again before queueing." });
  }
});
router.get("/studio/exports", async (req, res): Promise<void> => {
  const parsed = ListStudioExportsQueryParams.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Choose a valid movie cursor and page size (1–100)." }); return; }
  const rows = await db.select().from(studioExportsTable)
    .where(parsed.data.beforeId === undefined ? undefined : lt(studioExportsTable.id, parsed.data.beforeId))
    .orderBy(desc(studioExportsTable.id)).limit(parsed.data.limit ?? 100);
  res.json(ListStudioExportsResponse.parse(rows.map(exportView)));
});
router.post("/studio/exports", async (req, res): Promise<void> => {
  const parsed = CreateStudioExportBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Choose an episode, orientation, and resolution." }); return; }
  const { requestId, episodeId, aspectRatio, quality } = parsed.data;
  // Look up before episode validation and capacity checks: a lost acknowledgement
  // must remain recoverable even after the job finishes or the queue fills.
  async function replayRequest(): Promise<boolean> {
    if (!requestId) return false;
    const [existing] = await db.select().from(studioExportsTable).where(eq(studioExportsTable.requestId, requestId));
    if (!existing) return false;
    if (existing.episodeId !== episodeId || existing.aspectRatio !== aspectRatio || existing.quality !== quality) {
      res.status(409).json({ error: "This request ID was already used for a different movie. Use a new request ID." });
    } else {
      res.status(202).json(CreateStudioExportResponse.parse(exportView(existing)));
    }
    return true;
  }
  if (await replayRequest()) return;
  if (parsed.data.episodeId) {
    const [episode] = await db.select().from(studioEpisodesTable).where(eq(studioEpisodesTable.id, parsed.data.episodeId));
    if (!episode) { res.status(404).json({ error: "Episode not found" }); return; }
  }
  const pending = await db.select().from(studioExportsTable).where(inArray(studioExportsTable.status, ["queued", "rendering"]));
  const existing = !requestId && pending.find(job => job.episodeId === episodeId && job.aspectRatio === aspectRatio && job.quality === quality);
  if (existing) { res.status(202).json(CreateStudioExportResponse.parse(exportView(existing))); return; }
  if (pending.length >= 16) { res.status(429).json({ error: "The movie queue is full. Wait for the current exports." }); return; }
  // The unique database constraint arbitrates concurrent requests, including
  // requests handled by different API instances. Only the winner queues work.
  const [job] = await db.insert(studioExportsTable).values({ ...parsed.data, status: "queued" })
    .onConflictDoNothing({ target: studioExportsTable.requestId }).returning();
  if (!job) {
    if (await replayRequest()) return;
    res.status(503).json({ error: "Could not recover the movie request. Retry with the same request ID." });
    return;
  }
  res.status(202).json(CreateStudioExportResponse.parse(exportView(job!)));
  void wakeMovieWorker();
});
router.delete("/studio/exports/:id", async (req, res): Promise<void> => {
  // The parent router protects all /studio routes with requireStudioAccess.
  const parsed = DeleteStudioExportParams.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: "Invalid movie ID" }); return; }
  const [job] = await db.select().from(studioExportsTable).where(eq(studioExportsTable.id, parsed.data.id));
  if (!job) { res.sendStatus(204); return; }
  const finished = ["ready", "failed", "cancelled"] as const;
  if (!finished.some(status => status === job.status)) {
    res.status(409).json({ error: "Cancel this active movie before deleting it." }); return;
  }
  // Storage first: a failed object deletion must leave a retryable history entry.
  // If the DB delete fails afterwards, a retry tolerates the now-missing object.
  if (job.objectPath) {
    try {
      const file = await new ObjectStorageService().getObjectEntityFile(job.objectPath);
      await file.delete({ ignoreNotFound: true });
    } catch (error) {
      if (!(error instanceof ObjectNotFoundError) &&
          !(typeof error === "object" && error !== null && "code" in error && error.code === 404)) {
        req.log.error({ err: error, exportId: job.id }, "Movie deletion failed");
        res.status(503).json({ error: "Could not delete the stored movie. Its history was kept; please try again." }); return;
      }
    }
  }
  await db.delete(studioExportsTable).where(and(
    eq(studioExportsTable.id, job.id), inArray(studioExportsTable.status, [...finished]),
  ));
  res.sendStatus(204);
});
router.post("/studio/exports/:id/cancel", async (req, res): Promise<void> => {
  const parsed = CancelStudioExportParams.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: "Invalid movie ID" }); return; }
  const job = await cancelMovieExport(parsed.data.id);
  if (!job) { res.status(404).json({ error: "Movie not found" }); return; }
  if (job.status !== "cancelled") { res.status(409).json({ error: "This movie has already finished and cannot be cancelled." }); return; }
  res.json(CancelStudioExportResponse.parse(exportView(job)));
});
router.get("/studio/exports/:id/file", async (req, res): Promise<void> => {
  const parsed = DownloadStudioExportParams.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: "Invalid movie ID" }); return; }
  const [job] = await db.select().from(studioExportsTable).where(and(eq(studioExportsTable.id, parsed.data.id), eq(studioExportsTable.status, "ready")));
  if (!job?.objectPath) { res.status(404).json({ error: "Movie is not ready yet" }); return; }
  res.setHeader("Content-Disposition", `inline; filename="storyboard-${job.id}-${job.quality}.mp4"`);
  const file = await new ObjectStorageService().getObjectEntityFile(job.objectPath);
  await streamPrivateMedia(file, req, res);
});
export default router;
