import { useState } from 'react';
import { useClerk } from '@clerk/react';
import { AlertTriangle } from 'lucide-react';
import type { ErrorFallbackProps } from './error-boundary';
import { BrandScreen } from './PublicPages';

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
    <BrandScreen step="Something went wrong">
      <span className="brand-screen-icon is-warning" aria-hidden="true"><AlertTriangle size={20} /></span>
      <h1 className="brand-screen-title">We hit a problem</h1>
      <p className="brand-screen-copy">
        Try again, or sign out and return to the home page to restart sign-in. Your saved studio work is not affected.
      </p>
      {import.meta.env.DEV ? (
        <pre className="brand-screen-code">{error.message || String(error)}</pre>
      ) : null}
      <div className="brand-screen-actions">
        <button
          type="button"
          onClick={resetError}
          className="btn btn-primary"
          data-testid="button-retry-app-error"
        >
          Try again
        </button>
        <button
          type="button"
          onClick={() => void returnHome()}
          disabled={leaving}
          className="btn btn-quiet"
          data-testid="button-sign-out-home-app-error"
        >
          {leaving ? 'Returning home…' : 'Sign out and return home'}
        </button>
      </div>
    </BrandScreen>
  );
}
