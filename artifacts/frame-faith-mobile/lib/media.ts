/** Provider URLs are untrusted. Only the configured API origin gets credentials. */
export async function mediaSource(
  value: string,
  apiOrigin: string,
  getToken: () => Promise<string | null>,
): Promise<{ uri: string; headers: Record<string, string> }> {
  const api = new URL(apiOrigin);
  const url = new URL(value, api);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Unsupported video URL.');
  }
  if (url.origin !== api.origin) return { uri: url.toString(), headers: {} };
  const token = await getToken();
  if (!token) throw new Error('Sign in again to watch or download this video.');
  return { uri: url.toString(), headers: { Authorization: `Bearer ${token}` } };
}
