import { getListStudioExportsQueryKey, listStudioExports, type StudioExport } from '@workspace/api-client-react';
import { useInfiniteQuery, type InfiniteData, type QueryClient } from '@tanstack/react-query';

const PAGE_SIZE = 100;
type MoviePage = { items: StudioExport[]; nextCursor: number | undefined };
export const movieHistoryQueryKey = () => [...getListStudioExportsQueryKey(), 'history'];

export function useMovieExportHistory() {
  const query = useInfiniteQuery({
    queryKey: movieHistoryQueryKey(),
    initialPageParam: undefined as number | undefined,
    queryFn: async ({ pageParam, signal }): Promise<MoviePage> => {
      const items = await listStudioExports(
        pageParam === undefined ? undefined : { beforeId: pageParam },
        { signal },
      );
      return { items, nextCursor: items.length === PAGE_SIZE ? items.at(-1)?.id : undefined };
    },
    getNextPageParam: (page: MoviePage) => page.nextCursor,
    refetchInterval: 3000,
  });
  // A refresh can move page boundaries. Never render duplicate IDs.
  const jobs = [...new Map(query.data?.pages.flatMap(page => page.items).map(job => [job.id, job])).values()];
  return { ...query, jobs };
}

// Update both the infinite studio history and any generated single-page queries.
export function updateMovieExportCaches(cache: QueryClient, update: (jobs: StudioExport[]) => StudioExport[]) {
  cache.setQueriesData<StudioExport[] | InfiniteData<MoviePage>>(
    { queryKey: getListStudioExportsQueryKey() },
    previous => {
      if (!previous) return previous;
      if (Array.isArray(previous)) return update(previous);
      return { ...previous, pages: previous.pages.map(page => ({ ...page, items: update(page.items) })) };
    },
  );
}
