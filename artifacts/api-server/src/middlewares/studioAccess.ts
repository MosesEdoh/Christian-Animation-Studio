import type { RequestHandler } from "express";

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
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Sign in to access the private studio." });
    return;
  }
  if (!isStudioEmailAllowed(req.user.email)) {
    res.status(403).json({ error: "This account has not been approved for this studio." });
    return;
  }
  next();
};
