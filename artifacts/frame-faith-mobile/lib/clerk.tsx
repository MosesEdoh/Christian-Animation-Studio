import { useEffect, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { useAuth, useUser } from '@clerk/expo';
import { setAuthTokenGetter, setDeviceTrustTokenGetter } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { StateScreen } from '@/components/ui';
import { MobileSignIn } from '@/components/MobileSignIn';
import { TrustedDeviceGate } from '@/components/TrustedDeviceGate';
import { getTrustedDeviceToken } from '@/lib/trusted-device';

export function mediaUrl(value: string) {
  return new URL(value, `https://${process.env.EXPO_PUBLIC_DOMAIN}`).toString();
}
export function MobileSession({ children }: { children: ReactNode }) {
  const { getToken, userId } = useAuth();
  const cache = useQueryClient();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setAuthTokenGetter(() => getToken());
    setDeviceTrustTokenGetter(Platform.OS === 'web' ? null : getTrustedDeviceToken);
    cache.clear();
    setReady(true);
    return () => {
      setAuthTokenGetter(null);
      setDeviceTrustTokenGetter(null);
    };
  }, [getToken, userId, cache]);
  return ready ? children : null;
}
export function AuthGate({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useUser();
  if (!isLoaded) return <StateScreen loading message="Loading your account…" />;
  return isSignedIn ? <TrustedDeviceGate>{children}</TrustedDeviceGate> : <MobileSignIn />;
}
