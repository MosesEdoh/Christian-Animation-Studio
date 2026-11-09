import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isIP } from "node:net";

const MAX_SOURCE_BYTES = 250 * 1024 * 1024;
const MAX_CLIP_BYTES = 100 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const CLIP_TIMEOUT_MS = 30_000;
const FFMPEG_TIMEOUT_MS = 3 * 60_000;

export type EpisodeVideoClip = {
  id: number;
  provider: string;
  status: string;
  url: string | null;
};

export type EpisodeVideoIssue = {
  clipId: number;
  provider: string;
  reason: string;
};

export type EpisodeVideoReport = {
  usedClipIds: number[];
  skippedClips: EpisodeVideoIssue[];
};

export type AssembledEpisodeVideo = {
  directory: string;
  outputPath: string;
  report: EpisodeVideoReport;
};

function isPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return false;
  }
  const ipVersion = isIP(host);
  if (ipVersion === 6) return false;
  if (ipVersion === 4) {
    const octets = host.split(".").map(Number);
    const [first, second] = octets;
    if (
      first === 0 || first === 10 || first === 127 || first >= 224 ||
      (first === 169 && second === 254) ||
      (first === 172 && second! >= 16 && second! <= 31) ||
      (first === 192 && second === 168) ||
      (first === 100 && second! >= 64 && second! <= 127)
    ) return false;
  }
  return true;
}

function validateClipUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The provider returned an invalid video URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password || !isPublicHostname(url.hostname)) {
    throw new Error("The provider video URL is not a safe public HTTPS address.");
  }
  return url;
}

async function fetchClip(urlValue: string, outputPath: string, remainingBytes: number): Promise<number> {
  let url = validateClipUrl(urlValue);
  let response: Response | undefined;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(CLIP_TIMEOUT_MS),
    });
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get("location");
    if (!location || redirect === MAX_REDIRECTS) {
      throw new Error("The provider video could not be downloaded.");
    }
    url = validateClipUrl(new URL(location, url).toString());
  }
  if (!response?.ok || !response.body) {
    throw new Error("The provider video could not be downloaded.");
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType && !contentType.startsWith("video/") && !contentType.includes("octet-stream")) {
    throw new Error("The provider URL did not return a video file.");
  }
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  const allowedBytes = Math.min(MAX_CLIP_BYTES, remainingBytes);
  if (contentLength > allowedBytes) {
    throw new Error("The episode video size limit was reached.");
  }

  let bytesWritten = 0;
  const limitStream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytesWritten += chunk.length;
      if (bytesWritten > allowedBytes) {
        callback(new Error("The episode video size limit was reached."));
        return;
      }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>),
      limitStream,
      createWriteStream(outputPath, { flags: "wx" }),
    );
  } catch (error) {
    await rm(outputPath, { force: true });
    throw error;
  }
  if (!bytesWritten) {
    await rm(outputPath, { force: true });
    throw new Error("The provider returned an empty video file.");
  }
  return bytesWritten;
}

function runMediaTool(command: "ffmpeg" | "ffprobe", args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), FFMPEG_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-2000); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
    child.on("error", error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", code => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(code === null ? "Media conversion timed out." : `Media conversion failed: ${stderr}`));
    });
  });
}

async function normalizeClip(inputPath: string, outputPath: string): Promise<void> {
  const audioStream = await runMediaTool("ffprobe", [
    "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=index", "-of", "csv=p=0", inputPath,
  ]);
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", inputPath];
  if (!audioStream) args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
  args.push(
    "-map", "0:v:0",
    "-map", audioStream ? "0:a:0" : "1:a:0",
    "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-threads", "2",
    "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
    "-shortest", "-movflags", "+faststart", outputPath,
  );
  await runMediaTool("ffmpeg", args);
}

export async function assembleEpisodeVideo(
  clips: EpisodeVideoClip[],
): Promise<AssembledEpisodeVideo> {
  const directory = await mkdtemp(join(tmpdir(), "frame-faith-episode-"));
  const report: EpisodeVideoReport = { usedClipIds: [], skippedClips: [] };
  const normalizedFiles: string[] = [];
  let sourceBytes = 0;
  try {
    for (const clip of clips) {
      if (clip.status !== "ready") {
        report.skippedClips.push({
          clipId: clip.id,
          provider: clip.provider,
          reason: `Clip is ${clip.status}, not ready for export.`,
        });
        continue;
      }
      if (!clip.url) {
        report.skippedClips.push({
          clipId: clip.id,
          provider: clip.provider,
          reason: "The provider did not provide a downloadable video URL.",
        });
        continue;
      }
      if (sourceBytes >= MAX_SOURCE_BYTES) {
        report.skippedClips.push({
          clipId: clip.id,
          provider: clip.provider,
          reason: "The episode video size limit was reached.",
        });
        continue;
      }

      const sequence = String(clip.id).padStart(6, "0");
      const sourcePath = join(directory, `source-${sequence}`);
      const normalizedPath = join(directory, `segment-${sequence}.mp4`);
      try {
        sourceBytes += await fetchClip(clip.url, sourcePath, MAX_SOURCE_BYTES - sourceBytes);
        await normalizeClip(sourcePath, normalizedPath);
        normalizedFiles.push(normalizedPath);
        report.usedClipIds.push(clip.id);
      } catch (error) {
        await rm(sourcePath, { force: true });
        await rm(normalizedPath, { force: true });
        report.skippedClips.push({
          clipId: clip.id,
          provider: clip.provider,
          reason: error instanceof Error && error.message.includes("size limit")
            ? "The episode video size limit was reached."
            : error instanceof Error && error.message.includes("safe public HTTPS")
              ? error.message
              : "The provider-hosted clip could not be downloaded or decoded for episode assembly.",
        });
      }
    }

    if (!normalizedFiles.length) {
      throw new Error("No downloadable, playable clips are available for this episode.");
    }

    const concatList = normalizedFiles.map(path => `file '${path}'`).join("\n");
    const concatPath = join(directory, "clips.txt");
    const outputPath = join(directory, "episode.mp4");
    await writeFile(concatPath, concatList);
    await runMediaTool("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "concat", "-safe", "0", "-i", concatPath,
      "-c", "copy", "-movflags", "+faststart", outputPath,
    ]);
    return { directory, outputPath, report };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function removeEpisodeVideo(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}
