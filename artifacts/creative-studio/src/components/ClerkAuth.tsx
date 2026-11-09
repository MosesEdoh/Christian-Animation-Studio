import { useEffect, useRef, type ReactNode } from 'react';
import { ClerkProvider, SignIn, SignUp, useClerk, useUser } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { useLocation } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { activateMovieBatchAccount } from '../lib/movieBatchProgress';

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
// Managed publishing injects this in production; intentionally empty in dev.
// Do not hardcode a fallback: development Clerk does not support this proxy.
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
export const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}
if (!clerkPubKey) throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY');

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: '#236d67', colorForeground: '#253d3c', colorMutedForeground: '#526866',
    colorDanger: '#a83232', colorBackground: '#fffdf8', colorInput: '#ffffff',
    colorInputForeground: '#253d3c', colorNeutral: '#253d3c',
    fontFamily: 'Manrope, sans-serif', borderRadius: '0.75rem',
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "bg-[#fffdf8] rounded-2xl w-[440px] max-w-full overflow-hidden",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-[#253d3c]", headerSubtitle: "text-[#526866]",
    socialButtonsBlockButtonText: "text-[#253d3c]", formFieldLabel: "text-[#253d3c]",
    footerActionLink: "text-[#236d67]", footerActionText: "text-[#526866]",
    dividerText: "text-[#526866]", identityPreviewEditButton: "text-[#236d67]",
    formFieldSuccessText: "text-[#236d67]", alertText: "text-[#a83232]",
    formButtonPrimary: "text-white",
  },
};

export function ClerkProviderWithRoutes({ children }: { children: ReactNode }) {
  const [, setLocation] = useLocation();
  return <ClerkProvider
    publishableKey={clerkPubKey}
    proxyUrl={clerkProxyUrl}
    appearance={clerkAppearance}
    signInUrl={`${basePath}/sign-in`}
    signUpUrl={`${basePath}/sign-up`}
    signInFallbackRedirectUrl={`${basePath}/studio`}
    signUpFallbackRedirectUrl={`${basePath}/studio`}
    localization={{
      signIn: { start: { title: "Welcome back", subtitle: "Sign in to your Frame & Faith studio" } },
      signUp: { start: { title: "Create your account", subtitle: "Join Frame & Faith with a verified email, then trust your device." } },
    }}
    routerPush={(to) => setLocation(stripBase(to))}
    routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
  >{children}</ClerkProvider>;
}

export function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const { isLoaded } = useUser();
  const queryClient = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    // An unresolved Clerk session is not a sign-out during a page reload.
    if (!isLoaded) return;
    return addListener(({ user }) => {
      const userId = user?.id ?? null;
      activateMovieBatchAccount(user?.externalId ?? userId);
      if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) queryClient.clear();
      prevUserIdRef.current = userId;
    });
  }, [addListener, queryClient, isLoaded]);
  return null;
}
export function SignInPage() {
  return <main className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
    <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />
  </main>;
}
export function SignUpPage() {
  return <main className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
    <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
  </main>;
}
export function LogoutButton({ testId }: { testId?: string }) {
  const { signOut } = useClerk();
  return <button className="btn btn-quiet" data-testid={testId}
    onClick={() => signOut({ redirectUrl: basePath || "/" })}>Sign out</button>;
}
