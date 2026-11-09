import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  customFetch,
  setAuthTokenGetter,
  setBaseUrl,
  setDeviceTrustTokenGetter,
} from "../src/custom-fetch";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  setAuthTokenGetter(null);
  setDeviceTrustTokenGetter(null);
  setBaseUrl(null);
});

test("mobile session and device tokens are sent only to the same-origin API path", async () => {
  const requests: Array<{ url: string; headers: Headers }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers) });
    return new Response("{}", { headers: { "content-type": "application/json" } });
  };
  setBaseUrl("https://studio.example.test");
  setAuthTokenGetter(() => "session-token");
  setDeviceTrustTokenGetter(() => "device-token");

  await customFetch("/api/studio/bootstrap");
  await customFetch("https://studio.example.test/media/episode.mp4");
  await customFetch("https://other.example.test/api/studio/bootstrap");

  assert.equal(requests[0]?.headers.get("authorization"), "Bearer session-token");
  assert.equal(requests[0]?.headers.get("x-studio-device"), "device-token");
  assert.equal(requests[1]?.headers.has("authorization"), false);
  assert.equal(requests[1]?.headers.has("x-studio-device"), false);
  assert.equal(requests[2]?.headers.has("authorization"), false);
  assert.equal(requests[2]?.headers.has("x-studio-device"), false);
});
