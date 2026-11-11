import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { signOutMock } = vi.hoisted(() => ({ signOutMock: vi.fn() }));

vi.mock('@clerk/react', () => ({
  useClerk: () => ({ signOut: signOutMock }),
}));

import { AuthErrorFallback } from '../src/components/AuthErrorFallback';

describe('AuthErrorFallback', () => {
  beforeEach(() => {
    signOutMock.mockReset();
    signOutMock.mockResolvedValue(undefined);
  });

  it('allows a visitor to retry the current route', () => {
    const resetError = vi.fn();
    render(<AuthErrorFallback error={new Error('route failed')} resetError={resetError} />);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(resetError).toHaveBeenCalledOnce();
  });

  it('signs out and returns to the public homepage', async () => {
    render(<AuthErrorFallback error={new Error('route failed')} resetError={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out and return home' }));

    await waitFor(() => expect(signOutMock).toHaveBeenCalledWith({ redirectUrl: '/' }));
    expect(screen.getByTestId('button-sign-out-home-app-error')).toBeDisabled();
  });
});
