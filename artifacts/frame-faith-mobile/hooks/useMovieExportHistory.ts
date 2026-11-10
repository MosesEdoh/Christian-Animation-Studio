import { getListStudioExportsQueryKey, listStudioExports, type StudioExport } from '@workspace/api-client-react';
import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';

const PAGE_SIZE = 100;
type MoviePage = { items: StudioExport[]; nextCursor: number | undefined };
export const mobileMovieHistoryQueryKey = () => [...getListStudioExportsQueryKey(), 'mobile-history'];

export function useMovieExportHistory() {
  const cache = useQueryClient();
  const query = useInfiniteQuery({
    queryKey: mobileMovieHistoryQueryKey(),
    initialPageParam: undefined as number | undefined,
    queryFn: async ({ pageParam, signal }): Promise<MoviePage> => {
      const previous = cache.getQueryData<InfiniteData<MoviePage, number | undefined>>(mobileMovieHistoryQueryKey());
      const index = previous?.pageParams.indexOf(pageParam) ?? -1;
      const oldPage = index >= 0 ? previous?.pages[index] : undefined;
      const items: StudioExport[] = [];
      let cursor = pageParam;
      let batch: StudioExport[];
      do {
        batch = await listStudioExports(
          { limit: PAGE_SIZE, ...(cursor === undefined ? {} : { beforeId: cursor }) },
          { signal },
        );
        items.push(...batch);
        cursor = batch.at(-1)?.id;
        // Refresh the original ID window, not just its first 100 rows. New
        // movies must not push already-loaded rows out of the history.
      } while (
        oldPage && batch.length === PAGE_SIZE && cursor !== undefined &&
        (oldPage.nextCursor === undefined || cursor > oldPage.nextCursor)
      );
      if (oldPage) {
        return {
          items: oldPage.nextCursor === undefined ? items : items.filter(job => job.id >= oldPage.nextCursor!),
          nextCursor: oldPage.nextCursor,
        };
      }
      return { items, nextCursor: batch.length === PAGE_SIZE ? cursor : undefined };
    },
    getNextPageParam: (page: MoviePage) => page.nextCursor,
    refetchInterval: 3000,
  });
  const jobs = [...new Map(query.data?.pages.flatMap(page => page.items).map(job => [job.id, job])).values()];
  return { ...query, jobs };
}
