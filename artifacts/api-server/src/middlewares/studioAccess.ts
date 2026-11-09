import type { RequestHandler } from "express";
import { getAuth } from "@clerk/express";
import { requireAuth } from "./requireAuth";

export function isStudioEmailAllowed(email: string | null | undefined): boolean {
  const allowed = (process.env.STUDIO_ALLOWED_EMAILS ?? "")
    .split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
  // Fail closed if the access list is missing.
  return !!email && allowed.includes(email.trim().toLowerCase());
}

export const requireStudioAccess: RequestHandler = (req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.vary("Cookie");
  res.vary("Authorization");
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: "Sign in to access the private studio." });
    return;
  }
  if (!isStudioEmailAllowed(auth.sessionClaims?.email as string | undefined) || auth.sessionClaims?.email_verified === false) {
    res.status(403).json({ error: "This account has not been approved for this studio." });
    return;
  }
  // Preserve the existing allowlist gate before provisioning.
  return requireAuth(req, res, next);
};
