import { Router, type IRouter } from "express";
import { and, asc, eq } from "drizzle-orm";
import {
  CreateStudioChildProfileBody,
  CreateStudioChildProfileResponse,
  DeleteStudioChildProfileParams,
  ListStudioChildProfilesResponse,
  UpdateStudioChildProfileBody,
  UpdateStudioChildProfileParams,
  UpdateStudioChildProfileResponse,
} from "@workspace/api-zod";
import { childProfilesTable, db } from "@workspace/db";

const router: IRouter = Router();
const GUARDIAN_NOTICE_VERSION = "guardian-profile-v1";

function guardianId(req: Express.Request): string | null {
  return req.dbUser?.id ?? null;
}

router.get("/studio/child-profiles", async (req, res): Promise<void> => {
  const ownerId = guardianId(req);
  if (!ownerId) {
    res.status(401).json({ error: "Sign in as a guardian to manage child profiles." });
    return;
  }
  const profiles = await db.select().from(childProfilesTable)
    .where(eq(childProfilesTable.guardianUserId, ownerId))
    .orderBy(asc(childProfilesTable.createdAt), asc(childProfilesTable.id));
  res.json(ListStudioChildProfilesResponse.parse(profiles));
});

router.post("/studio/child-profiles", async (req, res): Promise<void> => {
  const ownerId = guardianId(req);
  if (!ownerId) {
    res.status(401).json({ error: "Sign in as a guardian to create a child profile." });
    return;
  }
  const parsed = CreateStudioChildProfileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter a nickname and age range, and confirm the guardian notice." });
    return;
  }
  const displayName = parsed.data.displayName.trim();
  if (!displayName) {
    res.status(400).json({ error: "Enter a nickname for the child profile." });
    return;
  }
  const [profile] = await db.insert(childProfilesTable).values({
    guardianUserId: ownerId,
    displayName,
    ageBand: parsed.data.ageBand,
    status: "active",
    childSafeMode: true,
    guardianConsentAt: new Date(),
    guardianNoticeVersion: GUARDIAN_NOTICE_VERSION,
  }).returning();
  res.status(201).json(CreateStudioChildProfileResponse.parse(profile));
});

router.patch("/studio/child-profiles/:id", async (req, res): Promise<void> => {
  const ownerId = guardianId(req);
  if (!ownerId) {
    res.status(401).json({ error: "Sign in as a guardian to update a child profile." });
    return;
  }
  const params = UpdateStudioChildProfileParams.safeParse(req.params);
  const parsed = UpdateStudioChildProfileBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: "Choose a valid profile and enter valid profile details." });
    return;
  }
  const updates = {
    ...(parsed.data.displayName === undefined ? {} : { displayName: parsed.data.displayName.trim() }),
    ...(parsed.data.ageBand === undefined ? {} : { ageBand: parsed.data.ageBand }),
    ...(parsed.data.status === undefined ? {} : { status: parsed.data.status }),
  };
  if (updates.displayName === "") {
    res.status(400).json({ error: "Enter a nickname for the child profile." });
    return;
  }
  const [profile] = await db.update(childProfilesTable).set(updates)
    .where(and(
      eq(childProfilesTable.id, params.data.id),
      eq(childProfilesTable.guardianUserId, ownerId),
    ))
    .returning();
  if (!profile) {
    res.status(404).json({ error: "Child profile not found." });
    return;
  }
  res.json(UpdateStudioChildProfileResponse.parse(profile));
});

router.delete("/studio/child-profiles/:id", async (req, res): Promise<void> => {
  const ownerId = guardianId(req);
  if (!ownerId) {
    res.status(401).json({ error: "Sign in as a guardian to remove a child profile." });
    return;
  }
  const params = DeleteStudioChildProfileParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Choose a valid child profile." });
    return;
  }
  const [deleted] = await db.delete(childProfilesTable)
    .where(and(
      eq(childProfilesTable.id, params.data.id),
      eq(childProfilesTable.guardianUserId, ownerId),
    ))
    .returning({ id: childProfilesTable.id });
  if (!deleted) {
    res.status(404).json({ error: "Child profile not found." });
    return;
  }
  res.sendStatus(204);
});

export default router;
