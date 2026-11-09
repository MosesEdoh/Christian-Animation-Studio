// Unit tests inject the same branded auth handler installed by Clerk middleware.
// Real request verification is covered separately by the browser migration test.
export function clerkSession(claims: Record<string, unknown> | null, nativeId = "user_clerk") {
  return { auth: Object.assign(() => ({
    tokenType: "session_token",
    userId: claims ? nativeId : null,
    sessionClaims: claims ? { email_verified: true, ...claims } : null,
  }), { [Symbol.for("@clerk/express.auth")]: true }) };
}
