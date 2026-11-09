import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { MovieExports } from '../src/components/MovieExports';
import { episode } from './episodeFixtures';
import { movieSizeLabel } from '../src/lib/movieSize';

const api = vi.hoisted(() => ({ remove: vi.fn(), jobs: [] as any[] }));
vi.mock('../src/hooks/useMovieExportHistory', async importOriginal => ({
  ...await importOriginal<object>(),
  useMovieExportHistory: () => {
    const query = useQuery({
      queryKey: ['/api/studio/exports'], queryFn: async () => api.jobs, staleTime: Infinity,
    });
    return { ...query, jobs: query.data ?? [] };
  },
}));
vi.mock('@workspace/api-client-react', async importOriginal => ({
  ...await importOriginal<object>(),
  preflightStudioExport: vi.fn(async () => ({ canQueue: true })),
  usePreflightStudioExport: () => ({ data: { canQueue: true, cards: 1, cardLimit: 2000, playbackSeconds: 10, playbackLimitSeconds: 21600 }, isPending: false, isError: false }),
  useListStudioExports: () => useQuery({
    queryKey: ['/api/studio/exports'], queryFn: async () => api.jobs, staleTime: Infinity,
  }),
  useCreateStudioExport: () => ({ isPending: false }),
  useCancelStudioExport: () => ({}),
  useDeleteStudioExport: () => ({ mutateAsync: api.remove }),
}));
const job = (id: number, status = 'ready') => ({
  id, episodeId: episode.id, status, aspectRatio: '16:9', quality: '720p',
  progress: 100, error: null, url: status === 'ready' ? `/api/studio/exports/${id}/file` : null,
  sizeBytes: id === 3 ? 12_500_000 : null, createdAt: new Date().toISOString(),
});
beforeEach(() => {
  api.jobs = [job(3), job(2)];
  api.remove.mockReset();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());
function mount() {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cache.setQueryData(['/api/studio/exports'], api.jobs);
  return { cache, ...render(<QueryClientProvider client={cache}><MovieExports episodes={[episode]} /></QueryClientProvider>) };
}
it('requires confirmation and does nothing when declined', () => {
  vi.mocked(window.confirm).mockReturnValue(false);
  mount();
  fireEvent.click(screen.getByTestId('delete-movie-3'));
  expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/#3.*cannot be undone.*scripts.*will not be deleted/i));
  expect(api.remove).not.toHaveBeenCalled();
  expect(screen.getByTestId('movie-job-3')).toBeVisible();
});
it('disables deletion while pending, removes history, and selects the next preview', async () => {
  let finish!: () => void;
  api.remove.mockImplementation(() => new Promise<void>(resolve => {
    finish = () => { api.jobs = [job(2)]; resolve(); };
  }));
  const { cache } = mount();
  expect(screen.getByTestId('movie-size-3')).toHaveTextContent('12.5 MB');
  expect(screen.getByTestId('movie-size-2')).toHaveTextContent('Size unknown');
  const invalidate = vi.spyOn(cache, 'invalidateQueries');
  fireEvent.click(screen.getByTestId('delete-movie-3'));
  expect(api.remove).toHaveBeenCalledWith({ id: 3 });
  expect(screen.getByRole('button', { name: 'Deleting…' })).toBeDisabled();
  expect(screen.getByTestId('delete-movie-2')).toBeDisabled();
  finish();
  await waitFor(() => expect(screen.queryByTestId('movie-job-3')).not.toBeInTheDocument());
  expect(screen.queryByTestId('movie-size-3')).not.toBeInTheDocument();
  expect(screen.getByTestId('movie-size-2')).toHaveTextContent('Size unknown');
  expect(screen.getByTestId('movie-preview')).toHaveAttribute('src', '/api/studio/exports/2/file');
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['/api/studio/exports'] });
});
it('clears the preview and download when the last saved movie is removed', async () => {
  api.jobs = [job(3)];
  api.remove.mockImplementation(async () => { api.jobs = []; });
  mount();
  fireEvent.click(screen.getByTestId('delete-movie-3'));
  await waitFor(() => expect(screen.queryByTestId('movie-preview')).not.toBeInTheDocument());
  expect(screen.queryByTestId('download-movie')).not.toBeInTheDocument();
});
it('preserves a different selected preview after deletion', async () => {
  api.remove.mockImplementation(async () => { api.jobs = [job(2)]; });
  mount();
  fireEvent.change(screen.getByLabelText('Saved movie preview'), { target: { value: '2' } });
  fireEvent.click(screen.getByTestId('delete-movie-3'));
  await waitFor(() => expect(screen.queryByTestId('movie-job-3')).not.toBeInTheDocument());
  expect(screen.getByTestId('movie-preview')).toHaveAttribute('src', '/api/studio/exports/2/file');
});
it('retains the movie and restores deletion after an error', async () => {
  api.remove.mockRejectedValue(new Error('Storage unavailable. Please try again.'));
  mount();
  fireEvent.click(screen.getByTestId('delete-movie-3'));
  expect(await screen.findByRole('alert')).toHaveTextContent('Storage unavailable');
  expect(screen.getByTestId('movie-preview')).toHaveAttribute('src', '/api/studio/exports/3/file');
  expect(screen.getByTestId('delete-movie-3')).toBeEnabled();
  expect(screen.getByTestId('movie-size-3')).toHaveTextContent('12.5 MB');
});
it('only offers deletion for finished movies, leaving active movies on the cancel path', () => {
  api.jobs = ['queued', 'rendering', 'failed', 'cancelled'].map((status, i) => job(i + 1, status));
  mount();
  expect(screen.queryByTestId('delete-movie-1')).not.toBeInTheDocument();
  expect(screen.queryByTestId('delete-movie-2')).not.toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: 'Cancel movie' })).toHaveLength(2);
  expect(screen.getAllByRole('button', { name: 'Delete movie' })).toHaveLength(2);
});
it('offers deletion for older movies beyond the first sixteen entries', () => {
  api.jobs = Array.from({ length: 17 }, (_, index) => job(index + 1));
  mount();
  expect(screen.getByTestId('delete-movie-17')).toBeVisible();
});

it('formats exact byte sizes without treating unknown sizes as zero', () => {
  for (const [bytes, label] of [
    [null, 'Size unknown'], [undefined, 'Size unknown'], [0, '0 bytes'],
    [999, '999 bytes'], [1000, '1 kB'], [1_500_000, '1.5 MB'],
    [3_000_000_000, '3 GB'],
  ] as const) expect(movieSizeLabel(bytes)).toBe(label);
});

it('shows sizes only for saved movies, not active or unsuccessful exports', () => {
  api.jobs = ['queued', 'rendering', 'failed', 'cancelled'].map((status, i) => job(i + 1, status));
  mount();
  expect(screen.queryByText('Size unknown')).not.toBeInTheDocument();
  expect(screen.queryByTestId('movie-size-3')).not.toBeInTheDocument();
});
