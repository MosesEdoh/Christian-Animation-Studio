import { Router } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db, studioExportsTable, studioEpisodesTable } from "@workspace/db";
import { CreateStudioExportBody, CreateStudioExportResponse, ListStudioExportsResponse, DownloadStudioExportParams, CancelStudioExportParams, CancelStudioExportResponse } from "@workspace/api-zod";
import { cancelMovieExport, exportView, wakeMovieWorker } from "../lib/movieRenderer";
import { ObjectStorageService } from "../lib/objectStorage";
import { streamPrivateMedia } from "../lib/privateMedia";

const router = Router();
router.get("/studio/exports", async (_req, res): Promise<void> => {
  const rows = await db.select().from(studioExportsTable).orderBy(desc(studioExportsTable.id)).limit(100);
  res.json(ListStudioExportsResponse.parse(rows.map(exportView)));
});
router.post("/studio/exports", async (req, res): Promise<void> => {
  const parsed = CreateStudioExportBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Choose an episode, orientation, and resolution." }); return; }
  if (parsed.data.episodeId) {
    const [episode] = await db.select().from(studioEpisodesTable).where(eq(studioEpisodesTable.id, parsed.data.episodeId));
    if (!episode) { res.status(404).json({ error: "Episode not found" }); return; }
  }
  const pending = await db.select().from(studioExportsTable).where(inArray(studioExportsTable.status, ["queued", "rendering"]));
  const existing = pending.find(job => job.episodeId === parsed.data.episodeId && job.aspectRatio === parsed.data.aspectRatio && job.quality === parsed.data.quality);
  if (existing) { res.status(202).json(CreateStudioExportResponse.parse(exportView(existing))); return; }
  if (pending.length >= 16) { res.status(429).json({ error: "The movie queue is full. Wait for the current exports." }); return; }
  const [job] = await db.insert(studioExportsTable).values({ ...parsed.data, status: "queued" }).returning();
  res.status(202).json(CreateStudioExportResponse.parse(exportView(job!)));
  void wakeMovieWorker();
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
