import { useCallback, useEffect, useState } from "react";
import type { AuthUser } from "@workspace/api-client-react";
export type { AuthUser };

export function useAuth() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/auth/user", { credentials: "include", cache: "no-store" });
      if (!response.ok) throw new Error("Unable to check sign-in. Please reload.");
      const data = await response.json() as { user: AuthUser | null };
      setUser(data.user);
      setError(null);
    } catch (cause) {
      setUser(null);
      setError(cause instanceof Error ? cause.message : "Sign-in check failed.");
    } finally { setIsLoading(false); }
  }, []);
  useEffect(() => {
    void refresh();
    const focus = () => { void refresh(); };
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [refresh]);
  const login = useCallback(() => {
    const base = import.meta.env.BASE_URL.replace(/\/+$/, "") || "/";
    window.location.assign(`/api/login?returnTo=${encodeURIComponent(base)}`);
  }, []);
  const logout = useCallback(() => { window.location.assign("/api/logout?returnTo=/"); }, []);
  return { user, isLoading, error, isAuthenticated: !!user, login, logout, refresh };
}
