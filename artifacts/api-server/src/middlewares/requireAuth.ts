import { getAuth } from "@clerk/express";
import { db, usersTable, type User } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { RequestHandler } from "express";

declare global {
  namespace Express {
    interface Request { dbUser?: User }
  }
}

// Only verified session claims may resolve local application identity.
export const requireAuth: RequestHandler = async (req, res, next) => {
  const auth = getAuth(req);
  const userId = auth.sessionClaims?.userId;
  if (!auth.userId || typeof userId !== "string" || !userId) {
    res.status(401).json({ error: "Sign in to access the private studio." });
    return;
  }
  let [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) {
    [user] = await db.insert(usersTable).values({ id: userId }).onConflictDoNothing().returning();
    if (!user) [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  }
  if (!user) throw new Error("Could not provision local account");
  req.dbUser = user;
  next();
};
