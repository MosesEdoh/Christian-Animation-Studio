import { createStudioExport, type StudioExportInput } from '@workspace/api-client-react';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

it('the generated client sends the same request ID on retry and a new ID for a new intent', async () => {
  const job = { id: 27, episodeId: null, aspectRatio: '16:9', quality: '720p', status: 'ready' };
  const fetch = vi.fn()
    .mockRejectedValueOnce(new TypeError('Connection lost after server acceptance'))
    .mockResolvedValueOnce(new Response(JSON.stringify(job), { status: 202, headers: { 'Content-Type': 'application/json' } }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ...job, id: 28 }), { status: 202, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch);
  const data: StudioExportInput = {
    episodeId: null, aspectRatio: '16:9', quality: '720p', requestId: crypto.randomUUID(),
  };
  await expect(createStudioExport(data)).rejects.toThrow('Connection lost');
  expect((await createStudioExport({ ...data })).id).toBe(27);
  const next = { ...data, requestId: crypto.randomUUID() };
  expect((await createStudioExport(next)).id).toBe(28);
  expect(fetch.mock.calls.map(([url, options]) => ({ url, body: JSON.parse(options.body) }))).toEqual([
    { url: '/api/studio/exports', body: data },
    { url: '/api/studio/exports', body: data },
    { url: '/api/studio/exports', body: next },
  ]);
});
