import React, { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import { Platform, View, Text, Pressable, ActivityIndicator } from 'react-native';
import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import * as Crypto from 'expo-crypto';
import { useQueryClient } from '@tanstack/react-query';
import type { AuthUser } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

WebBrowser.maybeCompleteAuthSession();
export const AUTH_TOKEN_KEY = 'auth_session_token';
export function apiOrigin() {
  return Platform.OS === 'web' && typeof window !== 'undefined'
    ? window.location.origin : `https://${process.env.EXPO_PUBLIC_DOMAIN}`;
}
export function mediaUrl(value: string) { return new URL(value, apiOrigin()).toString(); }
type AuthState = { user: AuthUser | null; loading: boolean; error: string; headers: Record<string, string>; login: () => Promise<void>; logout: () => Promise<void> };
const Context = createContext<AuthState | null>(null);
export function useAuth() {
  const value = useContext(Context);
  if (!value) throw new Error('AuthProvider missing');
  return value;
}

function BrowserAuth({ children }: { children: ReactNode }) {
  const cache = useQueryClient();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`${apiOrigin()}/api/auth/user`, { credentials: 'include', cache: 'no-store' });
      if (!response.ok) throw new Error('Could not check sign-in. Please retry.');
      const data = await response.json();
      if (!data.user) cache.clear();
      setUser(data.user);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Sign-in check failed'); }
    finally { setLoading(false); }
  }, [cache]);
  useEffect(() => {
    void refresh();
    const focus = () => { void refresh(); };
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, [refresh]);
  const login = async () => { cache.clear(); window.location.assign(`${apiOrigin()}/api/login?returnTo=/`); };
  const logout = async () => { cache.clear(); window.location.assign(`${apiOrigin()}/api/logout?returnTo=/`); };
  return <Context.Provider value={{ user, loading, error, headers: {}, login, logout }}>{children}</Context.Provider>;
}
function NativeAuth({ children }: { children: ReactNode }) {
  const cache = useQueryClient();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [nonce] = useState(() => Crypto.randomUUID());
  const discovery = AuthSession.useAutoDiscovery(process.env.EXPO_PUBLIC_ISSUER_URL ?? 'https://replit.com/oidc');
  const redirectUri = AuthSession.makeRedirectUri({ scheme: 'frame-faith-mobile' });
  const [request, , promptAsync] = AuthSession.useAuthRequest({
    clientId: process.env.EXPO_PUBLIC_REPL_ID ?? '', scopes: ['openid', 'email', 'profile', 'offline_access'],
    redirectUri, usePKCE: true, extraParams: { nonce }, prompt: AuthSession.Prompt.Login,
  }, discovery);
  const refresh = useCallback(async () => {
    try {
      const saved = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
      if (!saved) { setUser(null); return; }
      const response = await fetch(`${apiOrigin()}/api/auth/user`, { headers: { Authorization: `Bearer ${saved}` } });
      if (!response.ok) throw new Error('Unable to check your studio session.');
      const data = await response.json();
      if (!data.user) { await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY); cache.clear(); }
      setUser(data.user); setToken(data.user ? saved : null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Sign-in failed'); }
    finally { setLoading(false); }
  }, [cache]);
  useEffect(() => { void refresh(); }, [refresh]);
  const login = async () => {
    setError('');
    try {
      if (!request || !discovery) throw new Error('Sign-in is still preparing. Try again shortly.');
      const result = await promptAsync();
      if (result.type !== 'success') return;
      if (!request.codeVerifier || result.params.state !== request.state) throw new Error('Sign-in verification failed. Please retry.');
      setLoading(true);
      const response = await fetch(`${apiOrigin()}/api/mobile-auth/token-exchange`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: result.params.code, code_verifier: request.codeVerifier, redirect_uri: redirectUri, state: request.state, nonce }),
      });
      if (!response.ok) throw new Error('Sign in with the account approved for this studio.');
      const data = await response.json();
      await SecureStore.setItemAsync(AUTH_TOKEN_KEY, data.token);
      cache.clear();
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Sign-in failed'); }
    finally { setLoading(false); }
  };
  const logout = async () => {
    try {
      if (token) await fetch(`${apiOrigin()}/api/mobile-auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    } finally {
      await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY); cache.clear(); setToken(null); setUser(null);
    }
  };
  return <Context.Provider value={{ user, loading, error, headers: token ? { Authorization: `Bearer ${token}` } : {}, login, logout }}>{children}</Context.Provider>;
}
export function AuthProvider({ children }: { children: ReactNode }) {
  return Platform.OS === 'web' ? <BrowserAuth>{children}</BrowserAuth> : <NativeAuth>{children}</NativeAuth>;
}
export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  if (auth.loading) return <View style={{ flex: 1, justifyContent: 'center', backgroundColor: colors.background }}><ActivityIndicator color={colors.primary} /></View>;
  if (auth.user) return <>{children}</>;
  return <View style={{ flex: 1, padding: 28, paddingTop: insets.top + 80, backgroundColor: colors.background, gap: 18 }}>
    <Text style={{ color: colors.teal, fontFamily: 'Manrope_700Bold' }}>FRAME & FAITH</Text>
    <Text style={{ color: colors.foreground, fontFamily: 'Fraunces_600SemiBold', fontSize: 32 }}>Your private studio</Text>
    <Text style={{ color: colors.mutedForeground, lineHeight: 23 }}>Sign in with your approved account to read stories, view references, and watch your movies.</Text>
    {(auth.error || (Platform.OS === 'web' && typeof window !== 'undefined' && window.location.search.includes('access=denied'))) && <Text style={{ color: colors.destructive }}>{auth.error || 'That account is not approved for this studio.'}</Text>}
    <Pressable testID="mobile-login" onPress={auth.login} style={{ padding: 17, borderRadius: 14, backgroundColor: colors.primary }}><Text style={{ color: colors.primaryForeground, fontWeight: '700', textAlign: 'center' }}>Sign in</Text></Pressable>
  </View>;
}
