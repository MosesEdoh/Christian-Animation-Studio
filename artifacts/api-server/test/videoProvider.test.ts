import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  generateGoogleOmniVideoBytes,
  submitVideoGeneration,
  VideoGenerationProviderError,
} from "../src/lib/video-provider";

const fakeMp4 = Buffer.from("0000ftypisom0000");
const completedWithInlineVideo = (bytes = fakeMp4) => new Response(JSON.stringify({
  status: "completed",
  steps: [{
    type: "model_output",
    content: [{
      type: "video",
      mime_type: "video/mp4",
      data: bytes.toString("base64"),
    }],
  }],
}), { status: 200, headers: { "content-type": "application/json" } });

test("Google Omni requests use server auth, the video model, and selected output settings", async () => {
  let requestedUrl = "";
  let requestedPayload: Record<string, any> | undefined;
  let requestedKey = "";
  const bytes = await generateGoogleOmniVideoBytes({
    prompt: "A gentle camera move across a painted forest.",
    referenceImage: { data: "cG5n", mimeType: "image/png" },
    aspectRatio: "9:16",
    resolution: "1080p",
    durationSeconds: 8,
  }, {
    apiKey: "test-key",
    fetcher: async (url, init) => {
      requestedUrl = String(url);
      requestedKey = new Headers(init?.headers).get("x-goog-api-key") ?? "";
      requestedPayload = JSON.parse(String(init?.body));
      return completedWithInlineVideo();
    },
  });

  assert.equal(requestedUrl, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.equal(requestedKey, "test-key");
  assert.equal(requestedPayload?.model, "gemini-omni-1.2-flash");
  assert.deepEqual(requestedPayload?.response_format, {
    type: "video",
    aspect_ratio: "9:16",
    resolution: "1080p",
    duration: "8s",
    delivery: "uri",
  });
  assert.deepEqual(requestedPayload?.input[0], {
    type: "image",
    mime_type: "image/png",
    data: "cG5n",
  });
  assert.equal(bytes.toString(), fakeMp4.toString());
});

test("Google-hosted video files are polled until active and downloaded as MP4", async () => {
  const calls: string[] = [];
  const bytes = await generateGoogleOmniVideoBytes({ prompt: "A storyboard scene." }, {
    apiKey: "test-key",
    wait: async () => {},
    fetcher: async (url) => {
      const target = String(url);
      calls.push(target);
      if (target.endsWith("/v1beta/interactions")) {
        return new Response(JSON.stringify({
          status: "completed",
          steps: [{
            type: "model_output",
            content: [{
              type: "video",
              mime_type: "video/mp4",
              uri: "https://generativelanguage.googleapis.com/v1beta/files/video-123:download?alt=media",
            }],
          }],
        }), { status: 200 });
      }
      if (target.endsWith("/v1beta/files/video-123")) {
        return new Response(JSON.stringify({ state: "ACTIVE" }), { status: 200 });
      }
      return new Response(fakeMp4, { status: 200, headers: { "content-type": "video/mp4" } });
    },
  });

  assert.equal(calls.length, 3);
  assert.equal(bytes.toString(), fakeMp4.toString());
});

test("quota failures return an actionable message without exposing provider details", async () => {
  await assert.rejects(
    generateGoogleOmniVideoBytes({ prompt: "A short clip." }, {
      apiKey: "test-key",
      fetcher: async () => new Response("internal provider error", { status: 429 }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof VideoGenerationProviderError);
      assert.equal(error.statusCode, 429);
      assert.match(error.message, /billing or quota limit/i);
      assert.doesNotMatch(error.message, /internal provider error/);
      return true;
    },
  );
});

test("missing server credentials and unsupported settings fail before a provider request", async () => {
  let requests = 0;
  const fetcher = async () => {
    requests += 1;
    return completedWithInlineVideo();
  };

  await assert.rejects(
    generateGoogleOmniVideoBytes({ prompt: "A short clip." }, { apiKey: "", fetcher }),
    /GEMINI_API_KEY/,
  );
  await assert.rejects(
    generateGoogleOmniVideoBytes({ prompt: "A short clip.", durationSeconds: 2 }, {
      apiKey: "test-key",
      fetcher,
    }),
    /3 to 15 seconds/,
  );
  assert.equal(requests, 0);
});

test("generated MP4s are persisted privately and returned as protected app URLs", async () => {
  let savedBytes: Buffer | undefined;
  const result = await submitVideoGeneration({
    prompt: "A short clip.",
    durationSeconds: 3,
  }, {
    apiKey: "test-key",
    fetcher: async () => completedWithInlineVideo(),
    persist: async (path) => {
      savedBytes = await readFile(path);
      return "/objects/exports/clip-id.mp4";
    },
  });

  assert.equal(result.provider, "google-omni");
  assert.equal(result.status, "ready");
  assert.equal(result.url, "/api/storage/objects/exports/clip-id.mp4");
  assert.equal(result.duration, "3s");
  assert.equal(savedBytes?.toString(), fakeMp4.toString());
});
