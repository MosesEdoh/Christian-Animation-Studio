import type { RequestHandler } from "express";
import { clerkClient, getAuth } from "@clerk/express";
import { eq } from "drizzle-orm";
import { db, studioTrustedDevicesTable } from "@workspace/db";
import { hashTrustedDeviceToken, readTrustedDeviceToken } from "../lib/trustedDevice";
import { requireAuth } from "./requireAuth";

const verifiedUserCache = new Map<string, { verified: boolean; expiresAt: number }>();
const DEVICE_MANAGEMENT_PATHS = new Set([
  "/trusted-device/status",
  "/trusted-device/enroll",
  "/trusted-device/revoke",
]);

async function hasVerifiedEmail(userId: string, claims: Record<string, unknown> | null | undefined): Promise<boolean> {
  const emailVerified = claims?.email_verified;
  if (emailVerified === true || emailVerified === "true") return true;
  if (emailVerified === false || emailVerified === "false") return false;

  const cached = verifiedUserCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.verified;
  try {
    const user = await clerkClient.users.getUser(userId);
    const verified = user.emailAddresses.some(address => address.verification?.status === "verified");
    verifiedUserCache.set(userId, { verified, expiresAt: Date.now() + 5 * 60 * 1000 });
    return verified;
  } catch {
    return false;
  }
}

export const requireStudioAccess: RequestHandler = async (req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.vary("Cookie");
  res.vary("Authorization");
  res.vary("X-Studio-Device");
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: "Sign in to access the private studio." });
    return;
  }
  const claims = auth.sessionClaims as Record<string, unknown> | null;
  if (!await hasVerifiedEmail(auth.userId, claims)) {
    res.status(403).json({ error: "Use a verified email address to access the studio." });
    return;
  }

  const isDeviceManagementRoute =
    req.baseUrl.endsWith("/studio") && DEVICE_MANAGEMENT_PATHS.has(req.path);
  if (!isDeviceManagementRoute) {
    const token = readTrustedDeviceToken(req);
    if (!token) {
      res.status(403).json({ error: "Trust this device before opening the studio." });
      return;
    }
    const [device] = await db
      .select({ id: studioTrustedDevicesTable.id })
      .from(studioTrustedDevicesTable)
      .where(eq(studioTrustedDevicesTable.tokenHash, hashTrustedDeviceToken(token)))
      .limit(1);
    if (!device) {
      res.status(403).json({ error: "Trust this device before opening the studio." });
      return;
    }
  }

  return requireAuth(req, res, next);
};
