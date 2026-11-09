import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MovieExports } from '../src/components/MovieExports';
import { episode } from './episodeFixtures';

const api = vi.hoisted(() => ({
  cancel: vi.fn(), create: vi.fn(), jobs: [] as any[],
}));
vi.mock('../src/hooks/useMovieExportHistory', async importOriginal => ({
  ...await importOriginal<object>(),
  useMovieExportHistory: () => ({ jobs: api.jobs, isError: false }),
}));
vi.mock('@workspace/api-client-react', async importOriginal => ({
  ...await importOriginal<object>(),
  preflightStudioExport: vi.fn(async () => ({ canQueue: true })),
  usePreflightStudioExport: () => ({ data: { canQueue: true, cards: 1, cardLimit: 2000, playbackSeconds: 10, playbackLimitSeconds: 21600 }, isPending: false, isError: false }),
  useListStudioExports: () => ({ data: api.jobs, isError: false }),
  useCreateStudioExport: () => ({ mutateAsync: api.create, isPending: false }),
  useCancelStudioExport: () => ({ mutateAsync: api.cancel }),
  useDeleteStudioExport: () => ({ mutateAsync: vi.fn() }),
}));
const job = (status: string) => ({
  id: 3, episodeId: episode.id, status, aspectRatio: '9:16', quality: '1080p',
  progress: 25, error: null, url: null, createdAt: new Date().toISOString(),
});
beforeEach(() => { api.jobs = []; api.cancel.mockReset(); api.create.mockReset(); });
const mount = () => {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cache.setQueryData(['/api/studio/exports'], api.jobs);
  return { cache, ...render(<QueryClientProvider client={cache}><MovieExports episodes={[episode]} /></QueryClientProvider>) };
};

it.each(['queued', 'rendering'])('cancels a %s movie with pending feedback and refreshes the list', async status => {
  api.jobs = [job(status)];
  let finish!: (value: unknown) => void;
  api.cancel.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const { cache } = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel movie' }));
  expect(screen.getByRole('button', { name: 'Cancelling…' })).toBeDisabled();
  expect(api.cancel).toHaveBeenCalledWith({ id: 3 });
  finish(job('cancelled'));
  await waitFor(() => expect(cache.getQueryData<any[]>(['/api/studio/exports'])?.[0].status).toBe('cancelled'));
});

it('shows cancellation separately from failure and retries the same format as a new export', async () => {
  api.jobs = [job('cancelled')];
  mount();
  expect(screen.getByText(/Cancelled. No movie was saved/)).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Cancel movie' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Build again' }));
  await waitFor(() => expect(api.create).toHaveBeenCalledWith({ data: {
    episodeId: episode.id, aspectRatio: '9:16', quality: '1080p',
  } }));
});

it('shows cancellation errors and restores the control for retry', async () => {
  api.jobs = [job('rendering')];
  api.cancel.mockRejectedValue(new Error('Could not cancel movie.'));
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel movie' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not cancel movie.');
  expect(screen.getByRole('button', { name: 'Cancel movie' })).toBeEnabled();
});
