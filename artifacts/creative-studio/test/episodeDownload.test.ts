import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { downloadEpisodeVideo } from '../src/lib/episodeDownload';

afterEach(() => mock.restoreAll());
const episode = { id: 42, number: 3, title: 'Hope / lumière' };
const skipped = [{ clipId: 9, provider: 'renderer', reason: 'Le clip a échoué.' }];
const mp4 = (issues: unknown[] = []) => new Response('video-bytes', {
  headers: {
    'content-type': 'video/mp4',
    'x-episode-video-report': Buffer.from(JSON.stringify({
      usedClipIds: [8], skippedClips: issues,
    })).toString('base64'),
  },
});

function browser() {
  const anchors: Array<{ href: string; download: string; click(): void }> = [];
  const timers: Array<() => void> = [];
  let clicks = 0;
  const revoke = mock.method(URL, 'revokeObjectURL', () => {});
  mock.method(URL, 'createObjectURL', (blob: Blob) => {
    assert.equal(blob.type, 'video/mp4');
    return 'blob:episode';
  });
  // These minimal browser objects exercise the actual save path without a browser.
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: (tag: string) => {
      assert.equal(tag, 'a');
      const anchor = { href: '', download: '', click: () => { clicks++; } };
      anchors.push(anchor);
      return anchor;
    },
  } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    setTimeout: (callback: () => void) => { timers.push(callback); },
  } });
  afterEach(() => {
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  return { anchors, timers, revoke, clicks: () => clicks };
}

test('downloads only the selected episode MP4, with credentials and a safe filename', async () => {
  const env = browser();
  const requests: unknown[] = [];
  mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push([url, init]);
    return mp4();
  });
  const result = await downloadEpisodeVideo(episode);
  assert.deepEqual(requests, [['/api/studio/episodes/42/video', { credentials: 'include', signal: undefined }]]);
  assert.equal(env.anchors[0].download, 'E03-Hope - lumière.mp4');
  assert.equal(env.anchors[0].href, 'blob:episode');
  assert.equal(env.clicks(), 1);
  assert.equal(env.revoke.mock.callCount(), 0);
  env.timers[0]();
  assert.equal(env.revoke.mock.callCount(), 1);
  assert.equal(result.failed, undefined);
  assert.match(result.message, /No clips were skipped/);
});

test('partial success preserves the server skip reasons including Unicode', async () => {
  const env = browser();
  mock.method(globalThis, 'fetch', async () => mp4(skipped));
  const result = await downloadEpisodeVideo(episode);
  assert.equal(env.clicks(), 1);
  assert.match(result.message, /1 clip\(s\) skipped/);
  assert.deepEqual(result.skippedClips, skipped);
});

test('cancellation aborts the request without failure or a saved file and allows retry', async () => {
  const env = browser();
  const controller = new AbortController();
  mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init?.signal, controller.signal);
    controller.abort();
    throw controller.signal.reason;
  });
  const result = await downloadEpisodeVideo(episode, controller.signal);
  assert.equal(result.failed, undefined);
  assert.match(result.message, /cancelled/);
  assert.equal(env.clicks(), 0);
  mock.method(globalThis, 'fetch', async () => mp4());
  assert.match((await downloadEpisodeVideo(episode, new AbortController().signal)).message, /download started/);
  assert.equal(env.clicks(), 1);
});

test('cancellation while reading the response body prevents saving', async () => {
  const env = browser();
  const controller = new AbortController();
  mock.method(globalThis, 'fetch', async () => {
    const response = mp4();
    mock.method(response, 'blob', async () => {
      controller.abort();
      return new Blob(['video'], { type: 'video/mp4' });
    });
    return response;
  });
  assert.match((await downloadEpisodeVideo(episode, controller.signal)).message, /cancelled/);
  assert.equal(env.clicks(), 0);
});

test('unavailable episodes show the explanation and skipped clips without saving a file', async () => {
  const env = browser();
  mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    error: 'No downloadable, playable clips are available for this episode.',
    skippedClips: skipped,
  }), { status: 422 }));
  const result = await downloadEpisodeVideo(episode);
  assert.equal(result.failed, true);
  assert.match(result.message, /No downloadable, playable clips/);
  assert.deepEqual(result.skippedClips, skipped);
  assert.equal(env.clicks(), 0);
});

test('expired sign-in, server errors, and network failures are explicit', async () => {
  mock.method(globalThis, 'fetch', async () => new Response('', { status: 401 }));
  assert.match((await downloadEpisodeVideo(episode)).message, /Sign in again/);
  mock.method(globalThis, 'fetch', async () => new Response('bad gateway', { status: 502 }));
  assert.match((await downloadEpisodeVideo(episode)).message, /502/);
  mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  assert.match((await downloadEpisodeVideo(episode)).message, /Check your connection/);
});

test('empty videos and HTML responses never trigger a download', async () => {
  const env = browser();
  mock.method(globalThis, 'fetch', async () => new Response('', {
    headers: { 'content-type': 'video/mp4' },
  }));
  assert.match((await downloadEpisodeVideo(episode)).message, /empty video/);
  mock.method(globalThis, 'fetch', async () => new Response('<html>Sign in</html>', {
    headers: { 'content-type': 'text/html' },
  }));
  assert.match((await downloadEpisodeVideo(episode)).message, /did not return an MP4/);
  assert.equal(env.clicks(), 0);
});

test('missing or damaged clip reports warn rather than claim a complete export', async () => {
  const env = browser();
  for (const header of ['', 'not-base64']) {
    mock.method(globalThis, 'fetch', async () => new Response('video', {
      headers: { 'content-type': 'video/mp4', 'x-episode-video-report': header },
    }));
    assert.match((await downloadEpisodeVideo(episode)).message, /report could not be read/);
  }
  assert.equal(env.clicks(), 2);
});
