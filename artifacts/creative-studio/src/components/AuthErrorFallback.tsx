import { useState } from 'react';
import { useClerk } from '@clerk/react';
import type { ErrorFallbackProps } from './error-boundary';

const homeUrl = import.meta.env.BASE_URL.replace(/\/$/, '') || '/';

export function AuthErrorFallback({ error, resetError }: ErrorFallbackProps) {
  const { signOut } = useClerk();
  const [leaving, setLeaving] = useState(false);

  async function returnHome() {
    if (leaving) return;
    setLeaving(true);
    try {
      await signOut({ redirectUrl: homeUrl });
    } catch {
      window.location.assign(homeUrl);
    }
  }

  return (
    <main className="min-h-screen w-full flex items-center justify-center bg-gray-50 p-6">
      <div className="max-w-lg w-full text-center">
        <h1 className="text-xl font-semibold text-gray-900">We hit a problem</h1>
        <p className="mt-2 text-sm text-gray-600">
          Try again, or sign out and return to the home page to restart sign-in.
        </p>
        {import.meta.env.DEV ? (
          <pre className="mt-4 overflow-x-auto rounded bg-gray-100 p-3 text-left text-xs text-gray-800">
            {error.message || String(error)}
          </pre>
        ) : null}
        <div className="mt-4 flex flex-wrap justify-center gap-3">
          <button
            type="button"
            onClick={resetError}
            className="rounded bg-gray-200 px-4 py-2 text-sm text-gray-900 hover:bg-gray-300"
            data-testid="button-retry-app-error"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => void returnHome()}
            disabled={leaving}
            className="rounded bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700 disabled:opacity-60"
            data-testid="button-sign-out-home-app-error"
          >
            {leaving ? 'Returning home…' : 'Sign out and return home'}
          </button>
        </div>
      </div>
    </main>
  );
}
