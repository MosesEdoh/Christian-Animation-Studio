import assert from 'node:assert/strict';
import { after, afterEach, before, mock, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import type { Clip, Episode, Scene, Shot, StudioBootstrap } from '@workspace/api-client-react';
import { assetSrc, buildSeriesPackage, downloadSeriesPackage } from '../src/lib/seriesPackage';

let directory: string;
let playableVideo: Buffer;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'series-zip-test-'));
  const path = join(directory, 'fixture.mp4');
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=30:d=0.3',
    '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', path,
  ], { timeout: 30_000 });
  playableVideo = await readFile(path);
});
afterEach(() => mock.restoreAll());
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

const episode = (id: number): Episode => ({
  id, projectId: 1, number: id, title: `Episode ${id}`, summary: 'A story',
  status: 'draft', progress: 0, duration: '1 min',
});
const scene = (id: number, number: number, episodeId = 1): Scene => ({
  id, number, episodeId, heading: `SCENE ${number}`, synopsis: '', content: 'Story text',
  status: 'draft', duration: '1 min',
});
const shot = (id: number, sceneId: number, number: number): Shot => ({
  id, sceneId, number, description: 'A shot', shotType: 'wide', movement: 'static',
  angle: 'eye-level', beat: '', duration: '1 sec', referenceImageUrl: null, status: 'draft',
});
const clip = (id: number, shotId: number, url: string | null = null): Clip => ({
  id, shotId, url, provider: 'provider', status: 'ready', thumbnailUrl: null,
  duration: '1 sec', createdAt: '2026-01-01T00:00:00Z',
});
const bootstrap = (): StudioBootstrap => ({
  project: { id: 1, title: 'Frame / Faith', logline: '', audience: '5–17', seasonLabel: 'Season 1', activeEpisodeId: 1 },
  episodes: [episode(1)], scenes: [scene(1, 1)], shots: [shot(1, 1, 1)],
  clips: [clip(1, 1)], assets: [], characters: [],
});
const options = { origin: 'https://studio.example' };
const folder = (id = 1) => `episodes/E${String(id).padStart(2, '0')}-Episode ${id}`;
const report = (files: Record<string, Uint8Array>, id = 1) =>
  strFromU8(files[`${folder(id)}/episode-video-report.txt`]);
const manifest = (files: Record<string, Uint8Array>) =>
  JSON.parse(strFromU8(files['series-manifest.json']));
const mp4 = (usedClipIds = [1], skippedClips: unknown[] = [], bytes = playableVideo) =>
  new Response(bytes, { headers: {
    'content-type': 'video/mp4',
    'x-episode-video-report': Buffer.from(JSON.stringify({ usedClipIds, skippedClips })).toString('base64'),
  } });

test('a ready archive contains a playable MP4, scripts, shot lists, and consistent reports', async () => {
  const requests: Array<{ input: unknown; init: unknown }> = [];
  mock.method(globalThis, 'fetch', async (input: unknown, init: unknown) => {
    requests.push({ input, init });
    return mp4();
  });
  const files = unzipSync(await buildSeriesPackage(bootstrap(), options));
  assert.deepEqual(Buffer.from(files[`${folder()}/episode.mp4`]), playableVideo);
  const exported = join(directory, 'exported.mp4');
  await writeFile(exported, files[`${folder()}/episode.mp4`]);
  execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', exported, '-f', 'null', '-'], { timeout: 30_000 });
  assert.match(report(files), /Status: ready/);
  assert.match(report(files), /Clips assembled: #1/);
  assert.match(strFromU8(files[`${folder()}/script.txt`]), /Story text/);
  assert.ok(files[`${folder()}/shot-list.json`]);
  assert.ok(files['character-bible.json']);
  assert.match(strFromU8(files['episode-video-reports.txt']), /Episode 1: ready/);
  const entry = manifest(files).episodes[0];
  assert.equal(entry.video, `${folder()}/episode.mp4`);
  assert.equal(entry.videoReport, `${folder()}/episode-video-report.txt`);
  assert.deepEqual(entry.usedClipIds, [1]);
  assert.deepEqual(entry.unavailableVideoClips, []);
  assert.deepEqual(requests, [{ input: '/api/studio/episodes/1/video', init: { credentials: 'include', signal: undefined } }]);
});

test('shot lists and scripts use scene and shot numbers, not database IDs or array order', async () => {
  const data = bootstrap();
  data.scenes = [scene(2, 2), scene(90, 1), scene(70, 1, 2)];
  data.shots = [shot(4, 2, 2), shot(8, 90, 2), shot(1, 2, 1), shot(6, 90, 1), shot(2, 70, 1)];
  mock.method(globalThis, 'fetch', async () => mp4());
  const files = unzipSync(await buildSeriesPackage(data, options));
  const shots = JSON.parse(strFromU8(files[`${folder()}/shot-list.json`]));
  assert.deepEqual(shots.map((shot: Shot) => shot.id), [6, 8, 1, 4]);
  const script = strFromU8(files[`${folder()}/script.txt`]);
  assert.ok(script.indexOf('SCENE 1') < script.indexOf('SCENE 2'));
});

test('partial and unavailable episodes have accurate per-episode and summary reports in the same ZIP', async () => {
  const data = bootstrap();
  data.episodes.push(episode(2));
  data.scenes.push(scene(2, 1, 2));
  data.shots.push(shot(2, 2, 1));
  data.clips.push(clip(2, 1), clip(3, 2));
  const missing = { clipId: 2, provider: 'provider', reason: 'The provider did not provide a downloadable video URL.' };
  const corrupt = { clipId: 3, provider: 'provider', reason: 'The provider-hosted clip could not be downloaded or decoded for episode assembly.' };
  mock.method(globalThis, 'fetch', async (input: string) => input.includes('/1/video')
    ? mp4([1], [missing])
    : Response.json({ error: 'No downloadable, playable clips are available for this episode.', usedClipIds: [], skippedClips: [corrupt] }, { status: 422 }));
  const files = unzipSync(await buildSeriesPackage(data, options));
  assert.ok(files[`${folder()}/episode.mp4`]);
  assert.equal(files[`${folder(2)}/episode.mp4`], undefined);
  assert.match(report(files), /Status: partial/);
  assert.match(report(files), /Clip 2 \(provider\).*did not provide/);
  assert.match(report(files, 2), /Status: unavailable/);
  assert.match(report(files, 2), /Video: not included/);
  assert.match(report(files, 2), /Clip 3 \(provider\).*decoded/);
  const entries = manifest(files).episodes;
  assert.equal(entries[0].videoStatus, 'partial');
  assert.deepEqual(entries[0].unavailableVideoClips, [missing]);
  assert.equal(entries[1].video, null);
  assert.deepEqual(entries[1].unavailableVideoClips, [corrupt]);
  const summary = strFromU8(files['episode-video-reports.txt']);
  assert.match(summary, /Episode 1: partial/);
  assert.match(summary, /Episode 2: unavailable/);
});

test('network and non-JSON failures produce reports rather than aborting ZIP creation', async () => {
  const data = bootstrap();
  data.episodes.push(episode(2), episode(3));
  data.clips[0].status = 'failed';
  mock.method(globalThis, 'fetch', async (input: string) => {
    if (input.includes('/1/video')) throw new TypeError('offline');
    if (input.includes('/2/video')) return new Response('gateway failure', { status: 502 });
    return Response.json({ error: 'No downloadable, playable clips are available for this episode.', skippedClips: [] }, { status: 422 });
  });
  const files = unzipSync(await buildSeriesPackage(data, options));
  assert.match(report(files), /service could not be reached/);
  assert.match(report(files), /failed, not ready/);
  assert.match(report(files, 2), /failed \(502\)/);
  assert.match(report(files, 3), /No downloadable, playable clips/);
  assert.ok(manifest(files).episodes.every((entry: { video: null }) => entry.video === null));
});

test('empty videos are never packaged and malformed reports produce an explicit warning', async () => {
  const data = bootstrap();
  data.episodes.push(episode(2));
  mock.method(globalThis, 'fetch', async (input: string) => input.includes('/1/video')
    ? mp4([], [], Buffer.alloc(0))
    : new Response(playableVideo, { headers: { 'content-type': 'video/mp4', 'x-episode-video-report': 'not-base64-JSON' } }));
  const files = unzipSync(await buildSeriesPackage(data, options));
  assert.equal(files[`${folder()}/episode.mp4`], undefined);
  assert.match(report(files), /empty video/);
  assert.ok(files[`${folder(2)}/episode.mp4`]);
  assert.match(report(files, 2), /Status: partial/);
  assert.match(report(files, 2), /clip report could not be read/);
});

test('the cumulative ZIP limit keeps the first video and reports subsequent videos as not included', async () => {
  const data = bootstrap();
  data.episodes.push(episode(2));
  mock.method(globalThis, 'fetch', async () => mp4());
  const files = unzipSync(await buildSeriesPackage(data, { ...options, maxVideoBytes: playableVideo.length }));
  assert.ok(files[`${folder()}/episode.mp4`]);
  assert.equal(files[`${folder(2)}/episode.mp4`], undefined);
  assert.match(report(files, 2), /Status: not-included-size-limit/);
  assert.match(report(files, 2), /video-size limit was reached/);
  assert.equal(manifest(files).episodes[1].video, null);
});

test('failed provider URLs are retained as links, with private references included using authenticated URLs', async () => {
  const data = bootstrap();
  data.clips[0].url = 'https://provider.example/expired.mp4';
  data.assets = [{
    id: 5, projectId: 1, episodeId: null, sceneId: null, characterId: null,
    kind: 'storyboard', objectPath: '/objects/reference', name: 'frame.png',
    contentType: 'image/png', createdAt: '2026-01-01T00:00:00Z',
  }];
  const calls: Array<[string, RequestInit | undefined]> = [];
  mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    calls.push([String(input), init]);
    if (String(input).includes('/video')) return mp4();
    if (String(input).startsWith('/api/storage')) return new Response('reference');
    return new Response('expired', { status: 403 });
  });
  const files = unzipSync(await buildSeriesPackage(data, options));
  assert.equal(strFromU8(files['references/0005-frame.png']), 'reference');
  assert.match(strFromU8(files['clip-links.txt']), /Clip 1.*https:\/\/provider.example\/expired.mp4/);
  assert.equal(files['clips/clip-0001.mp4'], undefined);
  assert.deepEqual(calls[1], ['/api/storage/objects/reference', { credentials: 'include', signal: undefined }]);
  assert.deepEqual(calls[2][1], { credentials: 'omit', signal: undefined });
  assert.equal(assetSrc('/objects/a'), '/api/storage/objects/a');
});

test('oversized raw provider clips fall back to links and private reference failures stay explicit', async () => {
  const data = bootstrap();
  data.clips[0].url = 'https://provider.example/huge.mp4';
  mock.method(globalThis, 'fetch', async (input: string | URL) =>
    String(input).startsWith('/api/') ? mp4()
      : new Response('123456789', { headers: { 'content-length': '9' } }));
  const files = unzipSync(await buildSeriesPackage(data, { ...options, maxVideoBytes: 8 }));
  assert.ok(files['clip-links.txt']);
  assert.equal(files['clips/clip-0001.mp4'], undefined);
  data.assets = [{
    id: 5, projectId: 1, episodeId: null, sceneId: null, characterId: null,
    kind: 'storyboard', objectPath: '/objects/private', name: 'private.png',
    contentType: 'image/png', createdAt: '2026-01-01T00:00:00Z',
  }];
  mock.method(globalThis, 'fetch', async () => new Response(null, { status: 401 }));
  await assert.rejects(buildSeriesPackage(data, options), /Sign in again.*private reference/);
});

test('pre-cancelled packages reject before requesting any files', async () => {
  const controller = new AbortController();
  controller.abort();
  const fetch = mock.method(globalThis, 'fetch', async () => mp4());
  await assert.rejects(buildSeriesPackage(bootstrap(), { ...options, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(fetch.mock.callCount(), 0);
});

for (const stage of ['episode', 'reference', 'clip'] as const) {
  for (const pending of ['request', 'body', 'late body'] as const) {
    test(`cancellation stops ${stage} ${pending} without falling back or fetching more files`, async () => {
      const data = bootstrap();
      data.assets = [{
        id: 5, projectId: 1, episodeId: null, sceneId: null, characterId: null,
        kind: 'storyboard', objectPath: '/objects/reference', name: 'frame.png',
        contentType: 'image/png', createdAt: '2026-01-01T00:00:00Z',
      }];
      data.clips[0].url = 'https://provider.example/clip.mp4';
      data.clips.push(clip(2, 1, 'https://provider.example/next.mp4'));
      const controller = new AbortController();
      let started!: () => void;
      const reached = new Promise<void>(resolve => { started = resolve; });
      let finishLate!: () => void;
      const wait = () => new Promise<never | ArrayBuffer>((resolve, reject) => {
        finishLate = () => resolve(new ArrayBuffer(4));
        controller.signal.addEventListener('abort', () => {
          if (pending !== 'late body') reject(controller.signal.reason);
        }, { once: true });
        started();
      });
      const requests: string[] = [];
      mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
        assert.equal(init?.signal, controller.signal);
        const path = String(input);
        requests.push(path);
        const target = stage === 'episode' ? path.includes('/video')
          : stage === 'reference' ? path.includes('/api/storage') : path.startsWith('https://provider');
        if (!target) return path.includes('/video') ? mp4() : new Response('reference');
        if (pending === 'request') {
          await wait();
          throw new Error('Unreachable after abort');
        }
        const response = mp4();
        if (stage === 'episode') {
          mock.method(response, 'blob', async () => {
            await wait();
            return new Blob([playableVideo]);
          });
        } else {
          mock.method(response, 'arrayBuffer', async () => await wait());
        }
        return response;
      });
      const packing = buildSeriesPackage(data, { ...options, signal: controller.signal });
      const rejected = assert.rejects(packing, { name: 'AbortError' });
      await reached;
      const countAtCancellation = requests.length;
      controller.abort();
      if (pending === 'late body') finishLate();
      await rejected;
      assert.equal(requests.length, countAtCancellation);
      assert.equal(requests.length, stage === 'episode' ? 1 : stage === 'reference' ? 2 : 3);
    });
  }
}

test('the download wrapper creates one ZIP download with a safe name and revokes its URL', async () => {
  let blob: Blob | undefined;
  const anchor = { href: '', download: '', click: mock.fn() };
  const revoke = mock.method(URL, 'revokeObjectURL', () => {});
  const createUrl = mock.method(URL, 'createObjectURL', (value: Blob) => { blob = value; return 'blob:series'; });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location: { origin: options.origin },
    setTimeout(callback: () => void) { callback(); },
  } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement(tag: string) { assert.equal(tag, 'a'); return anchor; },
  } });
  try {
    mock.method(globalThis, 'fetch', async () => mp4());
    await downloadSeriesPackage(bootstrap());
    assert.equal(anchor.download, 'Frame - Faith-series-package.zip');
    assert.equal(anchor.href, 'blob:series');
    assert.equal(anchor.click.mock.callCount(), 1);
    assert.equal(blob?.type, 'application/zip');
    assert.ok(unzipSync(new Uint8Array(await blob!.arrayBuffer()))['series-manifest.json']);
    assert.equal(revoke.mock.calls[0].arguments[0], 'blob:series');

    // The archive can finish before the wrapper resumes. Cancellation must
    // still prevent a browser download at that final async boundary.
    const empty = { ...bootstrap(), episodes: [], assets: [], clips: [] };
    const controller = new AbortController();
    const cancelledDownload = downloadSeriesPackage(empty, controller.signal);
    controller.abort();
    await assert.rejects(cancelledDownload, { name: 'AbortError' });
    assert.equal(anchor.click.mock.callCount(), 1);
    assert.equal(createUrl.mock.callCount(), 1);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
