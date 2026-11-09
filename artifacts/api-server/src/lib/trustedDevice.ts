import { createHash, randomBytes } from "node:crypto";
import type { Request, Response } from "express";

export const TRUSTED_DEVICE_COOKIE_NAME = "ff_studio_device";
export const TRUSTED_DEVICE_HEADER_NAME = "x-studio-device";

export function createTrustedDeviceToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashTrustedDeviceToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function readTrustedDeviceToken(req: Request): string | null {
  const headerToken = req.get(TRUSTED_DEVICE_HEADER_NAME)?.trim();
  const cookieToken = req.headers.cookie
    ?.split(";")
    .map(value => value.trim())
    .find(value => value.startsWith(`${TRUSTED_DEVICE_COOKIE_NAME}=`))
    ?.slice(TRUSTED_DEVICE_COOKIE_NAME.length + 1);
  const token = headerToken || cookieToken;
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

export function setTrustedDeviceCookie(res: Response, token: string): void {
  res.cookie(TRUSTED_DEVICE_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api",
    maxAge: 365 * 24 * 60 * 60 * 1000,
  });
}

export function clearTrustedDeviceCookie(res: Response): void {
  res.clearCookie(TRUSTED_DEVICE_COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api",
  });
}
