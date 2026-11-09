import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mediaSource } from '../lib/media';
import { customFetch, setBaseUrl, setAuthTokenGetter } from '../../../lib/api-client-react/src/custom-fetch';

const origin = 'https://studio.example.test';
test('native playback/download headers only attach a fresh token to the API origin', async () => {
  let calls = 0;
  const getToken = async () => `fresh-${++calls}`;
  assert.deepEqual(await mediaSource('/api/studio/exports/1/file', origin, getToken), {
    uri: `${origin}/api/studio/exports/1/file`, headers: { Authorization: 'Bearer fresh-1' },
  });
  assert.equal((await mediaSource(`${origin}/api/studio/exports/1/file`, origin, getToken)).headers.Authorization, 'Bearer fresh-2');
  for (const url of ['https://provider.example.test/clip.mp4', '//provider.example.test/clip.mp4', `${origin}.evil.test/clip.mp4`, 'https://studio.example.test:444/clip.mp4']) {
    assert.deepEqual((await mediaSource(url, origin, getToken)).headers, {});
  }
  assert.equal(calls, 2, 'provider playback/downloads must not even retrieve the token');
  await assert.rejects(mediaSource('/api/private.mp4', origin, async () => null), /Sign in again/);
  await assert.rejects(mediaSource('javascript:alert(1)', origin, getToken), /Unsupported/);
  await assert.rejects(mediaSource('https://name:password@provider.example.test/clip.mp4', origin, getToken), /Unsupported/);
});

test('shared API transport never adds mobile tokens to external downloads', async () => {
  const original = globalThis.fetch;
  let tokenReads = 0;
  const requests: Array<{ url: string; headers: Headers }> = [];
  setBaseUrl(origin);
  setAuthTokenGetter(async () => { tokenReads++; return 'test-session-token'; });
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers) });
    return new Response('video', { status: 200 });
  };
  try {
    await customFetch('/api/studio/exports', { responseType: 'response' });
    await customFetch('https://provider.example.test/clip.mp4', { responseType: 'response' });
    await customFetch('//provider.example.test/clip.mp4', { responseType: 'response' });
    await customFetch(`${origin}.evil.test/clip.mp4`, { responseType: 'response' });
    assert.equal(requests[0].headers.get('authorization'), 'Bearer test-session-token');
    assert.ok(requests.slice(1).every(request => !request.headers.has('authorization')));
    assert.equal(tokenReads, 1);
    setBaseUrl(null);
    await customFetch('https://provider.example.test/clip.mp4', { responseType: 'response' });
    assert.equal(tokenReads, 1, 'missing API origin must fail closed');
  } finally {
    globalThis.fetch = original;
    setBaseUrl(null);
    setAuthTokenGetter(null);
  }
});
