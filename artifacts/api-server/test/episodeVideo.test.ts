import assert from "node:assert/strict";
import { after, afterEach, before, mock, test } from "node:test";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import {
  assembleEpisodeVideo, EpisodeVideoUnavailableError, removeEpisodeVideo,
  type EpisodeVideoClip,
} from "../src/lib/episodeVideo";

let fixtures: string;
const media: Buffer[] = [];
const clip = (id: number, overrides: Partial<EpisodeVideoClip> = {}): EpisodeVideoClip => ({
  id, provider: "test-provider", status: "ready", url: `https://media.example/${id}.mp4`, ...overrides,
});
const videoResponse = (bytes: Buffer | string = media[0], headers: Record<string, string> = {}) =>
  new Response(bytes, { headers: { "content-type": "video/mp4", ...headers } });
const mediaTool = (command: string, args: string[]) =>
  execFileSync(command, args, { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });

before(async () => {
  // Intentionally require real media tools: missing FFmpeg must fail, not skip coverage.
  fixtures = await mkdtemp(join(tmpdir(), "episode-test-fixtures-"));
  for (const [index, color] of ["red", "blue", "lime"].entries()) {
    const args = ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${color}:s=160x90:r=30:d=0.8`];
    if (index !== 1) {
      args.push("-f", "lavfi", "-i", `sine=frequency=440:sample_rate=${index === 0 ? 48000 : 32000}:duration=0.8`);
    }
    const path = join(fixtures, `${index}.mp4`);
    args.push("-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p");
    if (index !== 1) args.push("-c:a", "aac", "-ac", index === 0 ? "1" : "2");
    mediaTool("ffmpeg", [...args, path]);
    media.push(await readFile(path));
  }
});
afterEach(() => mock.restoreAll());
after(async () => { if (fixtures) await rm(fixtures, { recursive: true, force: true }); });

test("the production query orders by scene number, shot number, then clip creation and ID", async () => {
  // Building SQL never connects to a database. Use a non-secret placeholder in isolated CI.
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost/unused";
  const { episodeVideoClipsQuery } = await import("../src/lib/episodeVideoClips");
  const query = episodeVideoClipsQuery(77).toSQL();
  assert.match(query.sql, /where "studio_scenes"\."episode_id" = \$1/);
  assert.deepEqual(query.params, [77]);
  assert.match(query.sql, /order by "studio_scenes"\."number" asc, "studio_shots"\."number" asc, "studio_clips"\."created_at" asc, "studio_clips"\."id" asc$/);
});

test("real clips retain input order and normalize mixed audio, dimensions, and frame rate", async (t) => {
  const ids = [90, 7, 42]; // Deliberately not numeric/creation order.
  mock.method(globalThis, "fetch", async (input: URL) =>
    videoResponse(media[ids.indexOf(Number(input.pathname.slice(1).split(".")[0]))]));
  const result = await assembleEpisodeVideo(ids.map(id => clip(id)));
  t.after(() => removeEpisodeVideo(result.directory));
  assert.deepEqual(result.report, { usedClipIds: ids, skippedClips: [] });
  const probe = JSON.parse(mediaTool("ffprobe", [
    "-v", "error", "-show_streams", "-show_format", "-of", "json", result.outputPath,
  ]).toString());
  const video = probe.streams.find((stream: { codec_type: string }) => stream.codec_type === "video");
  const audio = probe.streams.find((stream: { codec_type: string }) => stream.codec_type === "audio");
  assert.equal(video.codec_name, "h264");
  assert.equal(video.width, 1280);
  assert.equal(video.height, 720);
  assert.equal(video.r_frame_rate, "30/1");
  assert.equal(audio.codec_name, "aac");
  assert.equal(audio.sample_rate, "44100");
  assert.equal(audio.channels, 2);
  assert.ok(Number(probe.format.duration) >= 2.4 && Number(probe.format.duration) < 2.8);
  for (const [time, channel] of [[0.3, 0], [1.2, 2], [2.1, 1]]) {
    const pixel = mediaTool("ffmpeg", [
      "-v", "error", "-ss", String(time), "-i", result.outputPath,
      "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
    ]);
    assert.ok(pixel[channel] > 200, `wrong clip at ${time}s: ${[...pixel]}`);
    assert.ok(pixel.filter((_, index) => index !== channel).every(value => value < 40));
    const samples = mediaTool("ffmpeg", [
      "-v", "error", "-ss", String(time), "-i", result.outputPath,
      "-t", "0.15", "-vn", "-f", "s16le", "-ac", "1", "pipe:1",
    ]);
    let energy = 0;
    for (let offset = 0; offset < samples.length; offset += 2) energy += samples.readInt16LE(offset) ** 2;
    const rms = Math.sqrt(energy / (samples.length / 2));
    assert.ok(channel === 2 ? rms < 20 : rms > 500, `unexpected audio at ${time}s: ${rms}`);
  }
  mediaTool("ffmpeg", ["-v", "error", "-xerror", "-i", result.outputPath, "-f", "null", "-"]);
});

test("partial episodes remain playable and identify missing, pending, failed, and corrupt clips", async (t) => {
  mock.method(globalThis, "fetch", async (input: URL) => {
    if (input.pathname === "/4.mp4") return new Response("denied", { status: 403 });
    if (input.pathname === "/5.mp4") return videoResponse("not a playable video");
    return videoResponse();
  });
  const result = await assembleEpisodeVideo([
    clip(1), clip(2, { url: null }), clip(3, { status: "processing" }), clip(4), clip(5),
  ]);
  t.after(() => removeEpisodeVideo(result.directory));
  assert.deepEqual(result.report.usedClipIds, [1]);
  assert.deepEqual(result.report.skippedClips.map(issue => issue.clipId), [2, 3, 4, 5]);
  assert.match(result.report.skippedClips[0].reason, /did not provide.*URL/);
  assert.match(result.report.skippedClips[1].reason, /processing, not ready/);
  assert.match(result.report.skippedClips[2].reason, /could not be downloaded/);
  assert.match(result.report.skippedClips[3].reason, /decoded/);
  mediaTool("ffmpeg", ["-v", "error", "-xerror", "-i", result.outputPath, "-f", "null", "-"]);
});

test("unavailable episodes retain precise reasons and remove their temporary files", async () => {
  const beforeDirs = (await readdir(tmpdir())).filter(name => name.startsWith("frame-faith-episode-")).sort();
  mock.method(globalThis, "fetch", async (input: URL) => {
    if (input.pathname === "/1.mp4") return new Response("<html>expired</html>", { headers: { "content-type": "text/html" } });
    if (input.pathname === "/2.mp4") return videoResponse("");
    throw new TypeError("provider offline");
  });
  await assert.rejects(assembleEpisodeVideo([
    clip(1), clip(2), clip(3), clip(4, { url: null }), clip(5, { status: "failed" }),
  ]), (error: unknown) => {
    assert.ok(error instanceof EpisodeVideoUnavailableError);
    assert.deepEqual(error.report.usedClipIds, []);
    assert.deepEqual(error.report.skippedClips.map(issue => issue.clipId), [1, 2, 3, 4, 5]);
    assert.match(error.report.skippedClips[0].reason, /did not return a video file/);
    assert.match(error.report.skippedClips[1].reason, /empty video file/);
    assert.match(error.report.skippedClips[2].reason, /downloaded or decoded/);
    return true;
  });
  await assert.rejects(assembleEpisodeVideo([]), EpisodeVideoUnavailableError);
  const afterDirs = (await readdir(tmpdir())).filter(name => name.startsWith("frame-faith-episode-")).sort();
  assert.deepEqual(afterDirs, beforeDirs);
});

test("unsafe URLs, unsafe redirects, and redirect loops are reported without fetching private hosts", async () => {
  const requests: string[] = [];
  mock.method(globalThis, "fetch", async (input: URL) => {
    requests.push(input.toString());
    return new Response(null, { status: 302, headers: {
      location: input.pathname === "/1.mp4" ? "http://127.0.0.1/private" : "/loop",
    } });
  });
  await assert.rejects(assembleEpisodeVideo([
    clip(1), clip(2), clip(3, { url: "https://localhost/private" }),
    clip(4, { url: "not a URL" }), clip(5, { url: "https://10.0.0.1/private" }),
  ]), (error: unknown) => {
    assert.ok(error instanceof EpisodeVideoUnavailableError);
    assert.equal(error.report.skippedClips.length, 5);
    assert.match(error.report.skippedClips[0].reason, /safe public HTTPS/);
    assert.match(error.report.skippedClips[3].reason, /invalid video URL/);
    return true;
  });
  assert.equal(requests.length, 5); // One unsafe redirect + four attempts at a loop.
  assert.ok(requests.every(url => new URL(url).hostname === "media.example"));
});

test("per-clip limits reject oversized production headers and enforce chunked-body caps", async () => {
  let cancelled = false;
  mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "video/mp4", "content-length": String(100 * 1024 * 1024 + 1) } }));
  await assert.rejects(assembleEpisodeVideo([clip(1)]), (error: unknown) => {
    assert.ok(error instanceof EpisodeVideoUnavailableError);
    assert.match(error.report.skippedClips[0].reason, /size limit/);
    return true;
  });
  assert.equal(cancelled, true);
  mock.method(globalThis, "fetch", async () => videoResponse(Buffer.alloc(33)));
  await assert.rejects(assembleEpisodeVideo([clip(1)], { clipBytes: 32, sourceBytes: 64 }), (error: unknown) => {
    assert.ok(error instanceof EpisodeVideoUnavailableError);
    assert.match(error.report.skippedClips[0].reason, /size limit/);
    return true;
  });
});

test("public redirects succeed and network timeouts are reported without preventing later clips", async (t) => {
  const requested: string[] = [];
  mock.method(globalThis, "fetch", async (input: URL) => {
    requested.push(input.toString());
    if (input.pathname === "/1.mp4") {
      return new Response(null, { status: 302, headers: { location: "/download.mp4" } });
    }
    if (input.pathname === "/2.mp4") throw new DOMException("Request timed out", "TimeoutError");
    return videoResponse();
  });
  const result = await assembleEpisodeVideo([clip(1), clip(2), clip(3)]);
  t.after(() => removeEpisodeVideo(result.directory));
  assert.deepEqual(result.report.usedClipIds, [1, 3]);
  assert.equal(result.report.skippedClips[0].clipId, 2);
  assert.match(result.report.skippedClips[0].reason, /downloaded or decoded/);
  assert.equal(requested[1], "https://media.example/download.mp4");
});

test("the remaining episode budget caps a later download even without content-length", async (t) => {
  mock.method(globalThis, "fetch", async () => videoResponse());
  const result = await assembleEpisodeVideo([clip(1), clip(2)], {
    clipBytes: media[0].length + 100, sourceBytes: media[0].length + 8,
  });
  t.after(() => removeEpisodeVideo(result.directory));
  assert.deepEqual(result.report.usedClipIds, [1]);
  assert.equal(result.report.skippedClips[0].clipId, 2);
  assert.match(result.report.skippedClips[0].reason, /size limit/);
});

test("aggregate source limit preserves the first MP4, reports later clips, and cleans up on request", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () => videoResponse());
  const result = await assembleEpisodeVideo([clip(1), clip(2), clip(3)], {
    clipBytes: media[0].length, sourceBytes: media[0].length,
  });
  try {
    assert.deepEqual(result.report.usedClipIds, [1]);
    assert.equal(fetchMock.mock.callCount(), 1);
    assert.ok(result.report.skippedClips.every(issue => /size limit/.test(issue.reason)));
    assert.equal(result.report.skippedClips.length, 2);
    assert.ok((await stat(result.outputPath)).size > 0);
  } finally {
    await removeEpisodeVideo(result.directory);
  }
  await assert.rejects(stat(result.directory), { code: "ENOENT" });
});

test("the HTTP handler streams MP4/report headers and returns exact unavailable reports", async () => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost/unused";
  const { db, studioEpisodesTable } = await import("@workspace/db");
  const { default: router } = await import("../src/routes/studio");
  const handler = router.stack.find(layer => layer.route?.path === "/studio/episodes/:id/video")!.route.stack[0].handle;
  let selectedClips = [clip(1)];
  mock.method(db, "select", (() => ({
    from(table: unknown) {
      if (table === studioEpisodesTable) return { where: async () => [{ id: 1, number: 8 }] };
      const chain = {
        innerJoin: () => chain, where: () => chain,
        orderBy: async () => selectedClips.map(clip => ({ clip })),
      };
      return chain;
    },
  })) as typeof db.select);
  async function invoke(disconnect?: "fetch" | "stream" | "request") {
    let warnings = 0;
    let providerSignal: AbortSignal | null | undefined;
    const chunks: Buffer[] = [];
    const headers = new Map<string, string>();
    let json: unknown;
    let status = 200;
    const res = Object.assign(new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        if (disconnect === "stream") this.destroy();
        callback();
      },
    }), {
      setHeader(key: string, value: string) { headers.set(key, value); },
      status(code: number) { status = code; return this; },
      json(body: unknown) { json = body; },
    });
    const req = Object.assign(new EventEmitter(), {
      params: { id: "1" }, log: { error() { warnings++; } },
    });
    mock.method(globalThis, "fetch", async (_input, init) => {
      providerSignal = init?.signal;
      if (disconnect === "fetch" || disconnect === "request") {
        return new Promise<Response>((_resolve, reject) => {
          providerSignal!.addEventListener("abort", () => reject(providerSignal!.reason), { once: true });
          if (disconnect === "request") req.emit("aborted");
          else res.destroy();
        });
      }
      return videoResponse();
    });
    await handler(req, res, () => {});
    assert.equal(req.listenerCount("aborted"), 0);
    return { status, headers, json, bytes: Buffer.concat(chunks), warnings, providerSignal };
  }
  const ready = await invoke();
  assert.equal(ready.status, 200);
  assert.equal(ready.headers.get("Content-Type"), "video/mp4");
  assert.match(ready.headers.get("Content-Disposition")!, /episode-8.mp4/);
  assert.equal(ready.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(JSON.parse(Buffer.from(ready.headers.get("X-Episode-Video-Report")!, "base64").toString()), {
    usedClipIds: [1], skippedClips: [],
  });
  assert.ok(ready.bytes.length > 0);
  selectedClips = [clip(1, { url: "https://localhost/private" }), clip(2, { url: null })];
  const unavailable = await invoke();
  assert.equal(unavailable.status, 422);
  assert.match(JSON.stringify(unavailable.json), /safe public HTTPS/);
  assert.match(JSON.stringify(unavailable.json), /did not provide a downloadable/);
  assert.equal(unavailable.bytes.length, 0);
  selectedClips = [clip(1)];
  for (const stage of ["fetch", "stream", "request"] as const) {
    const before = await episodeDirectories();
    const cancelled = await invoke(stage);
    assert.equal(cancelled.warnings, 0);
    assert.equal(cancelled.json, undefined);
    if (stage !== "stream") assert.equal(cancelled.providerSignal?.aborted, true);
    assert.deepEqual(await episodeDirectories(), before);
  }
  assert.ok((await invoke()).bytes.length > 0);
});

const episodeDirectories = async () =>
  (await readdir(tmpdir())).filter(name => name.startsWith("frame-faith-episode-")).sort();

test("pre-cancelled assembly does not fetch or leave temporary files", async () => {
  const before = await episodeDirectories();
  const fetchMock = mock.method(globalThis, "fetch", async () => videoResponse());
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(assembleEpisodeVideo([clip(1)], undefined, controller.signal), { name: "AbortError" });
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.deepEqual(await episodeDirectories(), before);
});

test("cancelling a pending provider request aborts fetch and does not try later clips", async () => {
  const before = await episodeDirectories();
  const controller = new AbortController();
  const fetchMock = mock.method(globalThis, "fetch", async (_input, init) => {
    assert.ok(init?.signal);
    return new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      controller.abort();
    });
  });
  await assert.rejects(assembleEpisodeVideo([clip(1), clip(2)], undefined, controller.signal), { name: "AbortError" });
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.deepEqual(await episodeDirectories(), before);
});

test("cancelling a streaming provider body closes the download and removes partial files", async () => {
  const before = await episodeDirectories();
  const controller = new AbortController();
  let cancelled = false;
  mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    start(stream) {
      stream.enqueue(new Uint8Array([1, 2, 3]));
      setTimeout(() => controller.abort(), 20);
    },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "video/mp4" } }));
  await assert.rejects(assembleEpisodeVideo([clip(1)], undefined, controller.signal), { name: "AbortError" });
  assert.equal(cancelled, true);
  assert.deepEqual(await episodeDirectories(), before);
});

for (const stage of ["probe", "normalize", "concat"]) {
  test(`cancelling during ${stage} kills the media process before deleting files and allows retry`, async () => {
    const before = await episodeDirectories();
    const bin = await mkdtemp(join(fixtures, "media-bin-"));
    const marker = join(bin, "pid");
    const realFfmpeg = execFileSync("which", ["ffmpeg"]).toString().trim();
    const realFfprobe = execFileSync("which", ["ffprobe"]).toString().trim();
    for (const tool of ["ffmpeg", "ffprobe"]) {
      const shouldBlock = tool === "ffprobe" ? `[ "${stage}" = probe ]`
        : stage === "concat" ? `case " $* " in *" concat "*) true;; *) false;; esac`
          : `[ "${stage}" = normalize ]`;
      const script = `#!/bin/sh
if ${shouldBlock}; then
  echo $$ > '${marker}'
  exec sleep 60
fi
exec '${tool === "ffmpeg" ? realFfmpeg : realFfprobe}' "$@"
`;
      await writeFile(join(bin, tool), script);
      await chmod(join(bin, tool), 0o755);
    }
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    const controller = new AbortController();
    mock.method(globalThis, "fetch", async () => videoResponse());
    const work = assembleEpisodeVideo([clip(1)], undefined, controller.signal);
    // Attach the rejection handler now, before triggering cancellation.
    const rejection = assert.rejects(work, { name: "AbortError" });
    try {
      let pid: number | undefined;
      for (let attempt = 0; attempt < 500; attempt++) {
        try { pid = Number(await readFile(marker, "utf8")); if (pid) break; } catch {}
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(pid, `media process never reached ${stage}`);
      controller.abort();
      await rejection;
      assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
      assert.deepEqual(await episodeDirectories(), before);
    } finally {
      controller.abort();
      await rejection;
      process.env.PATH = oldPath;
    }
    const retry = await assembleEpisodeVideo([clip(1)]);
    await removeEpisodeVideo(retry.directory);
    assert.deepEqual(await episodeDirectories(), before);
  });
}
