type AnalyticsData = Record<string, string | number | boolean>;

// Replit's publishing proxy injects Umami when hosted analytics is enabled.
// Per .local/skills/project-analytics/SKILL.md, do not add a script, website ID,
// collector URL, or analytics environment variables to the app itself.
// Development previews intentionally have no tracker unless a test supplies it.
declare global {
  interface Window {
    umami?: {
      track(name: string, data?: AnalyticsData): void | Promise<unknown>;
    };
  }
}

export function trackEvent(name: string, data?: AnalyticsData): void {
  if (typeof window === 'undefined') return;
  try {
    // Do not await analytics or let a rejected tracker request affect the app.
    const result = window.umami?.track(name, data);
    if (result) void Promise.resolve(result).catch(() => {});
  } catch {
    // Analytics must never interrupt creative work.
  }
}
