import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storePrivateMedia } from "./privateMedia";

const GOOGLE_API_ORIGIN = "https://generativelanguage.googleapis.com";
const GOOGLE_INTERACTIONS_URL = `${GOOGLE_API_ORIGIN}/v1beta/interactions`;
const DEFAULT_GOOGLE_VIDEO_MODEL = "gemini-omni-1.2-flash";
const MAX_GENERATED_VIDEO_BYTES = 150 * 1024 * 1024;
const DEFAULT_VIDEO_MIN_INTERVAL_MS = 15_000;

export type VideoAspectRatio = "16:9" | "9:16";
export type VideoResolution = "720p" | "1080p";
export type VideoReferenceImage = {
  data: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
};

export type VideoGenerationInput = {
  prompt: string;
  referenceImage?: VideoReferenceImage;
  aspectRatio?: VideoAspectRatio;
  resolution?: VideoResolution;
  durationSeconds?: number;
  signal?: AbortSignal;
};

export type VideoGenerationResult = {
  provider: "google-omni";
  status: "ready";
  url: string;
  thumbnailUrl: null;
  duration: string;
};

export class VideoGenerationProviderError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 502,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "VideoGenerationProviderError";
  }
}

type Fetcher = typeof fetch;
type ProviderDependencies = {
  apiKey?: string;
  fetcher?: Fetcher;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  persist?: (localPath: string, signal?: AbortSignal) => Promise<string>;
  admission?: VideoGenerationAdmission;
  model?: string;
};

export class VideoGenerationAdmission {
  private active = false;
  private nextAllowedAt = 0;

  constructor(
    private readonly minIntervalMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  acquire(): () => void {
    const currentTime = this.now();
    if (this.active) {
      throw new VideoGenerationProviderError(
        "A video clip is already generating. Wait for it to finish, then try again.",
        429,
      );
    }
    if (currentTime < this.nextAllowedAt) {
      const retryAfterSeconds = Math.ceil((this.nextAllowedAt - currentTime) / 1000);
      throw new VideoGenerationProviderError(
        `New video requests are being paced to protect Google quota. Try again in ${retryAfterSeconds} seconds.`,
        429,
        retryAfterSeconds,
      );
    }
    this.active = true;
    this.nextAllowedAt = currentTime + Math.max(0, this.minIntervalMs);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = false;
    };
  }
}

function configuredMinIntervalMs(): number {
  const configured = Number(process.env.GEMINI_VIDEO_MIN_INTERVAL_MS);
  if (!Number.isFinite(configured) || configured < 0) return DEFAULT_VIDEO_MIN_INTERVAL_MS;
  return Math.min(configured, 120_000);
}

const defaultVideoAdmission = new VideoGenerationAdmission(configuredMinIntervalMs());

function defaultWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("Video generation was cancelled."));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Video generation was cancelled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function googleErrorMessage(status: number): string {
  if (status === 402 || status === 429) {
    return "Google video generation is unavailable because the Gemini API project has a billing or quota limit.";
  }
  if (status === 401 || status === 403) {
    return "Google video generation is not enabled for the configured Gemini API project.";
  }
  if (status === 400) {
    return "Google rejected this video request. Review the prompt and output settings.";
  }
  return `Google video generation failed (HTTP ${status}).`;
}

async function readGoogleVideoError(response: Response): Promise<VideoGenerationProviderError> {
  const statusCode = response.status === 402 || response.status === 429
    ? response.status
    : response.status === 401 || response.status === 403
      ? 503
      : response.status === 400
        ? 400
        : 502;
  return new VideoGenerationProviderError(googleErrorMessage(response.status), statusCode);
}

function asVideoBytes(data: unknown): Buffer | null {
  if (typeof data !== "string" || !data.length) return null;
  const bytes = Buffer.from(data, "base64");
  return bytes.length ? bytes : null;
}

function validateMp4(bytes: Buffer): void {
  if (
    bytes.length < 12 ||
    bytes.toString("ascii", 4, 8) !== "ftyp" ||
    bytes.length > MAX_GENERATED_VIDEO_BYTES
  ) {
    throw new VideoGenerationProviderError(
      "Google returned a video that is empty, too large, or not a playable MP4.",
      502,
    );
  }
}

async function downloadGoogleHostedVideo(
  uriValue: string,
  apiKey: string,
  fetcher: Fetcher,
  signal: AbortSignal,
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>,
): Promise<Buffer> {
  let uri: URL;
  try {
    uri = new URL(uriValue);
  } catch {
    throw new VideoGenerationProviderError("Google returned an invalid video download link.");
  }
  if (
    uri.protocol !== "https:" ||
    uri.hostname !== "generativelanguage.googleapis.com" ||
    uri.username ||
    uri.password
  ) {
    throw new VideoGenerationProviderError("Google returned an unsafe video download link.");
  }
  const fileMatch = /^\/v1beta\/files\/([^/]+?)(?::download)?\/?$/.exec(uri.pathname);
  if (!fileMatch) {
    throw new VideoGenerationProviderError("Google returned an unsupported video download link.");
  }
  const fileName = decodeURIComponent(fileMatch[1]!);
  const statusUrl = new URL(`/v1beta/files/${encodeURIComponent(fileName)}`, GOOGLE_API_ORIGIN);
  let active = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    signal.throwIfAborted();
    const statusResponse = await fetcher(statusUrl, {
      headers: { "x-goog-api-key": apiKey },
      signal,
    });
    if (!statusResponse.ok) throw await readGoogleVideoError(statusResponse);
    const statusPayload = await statusResponse.json() as { state?: string };
    if (statusPayload.state === "ACTIVE") {
      active = true;
      break;
    }
    if (statusPayload.state === "FAILED") {
      throw new VideoGenerationProviderError("Google could not finish preparing the generated video.");
    }
    await wait(5_000, signal);
  }
  if (!active) {
    throw new VideoGenerationProviderError("Google did not make the generated video available in time.", 504);
  }

  const downloadResponse = await fetcher(uri, {
    headers: { "x-goog-api-key": apiKey },
    redirect: "error",
    signal,
  });
  if (!downloadResponse.ok) throw await readGoogleVideoError(downloadResponse);
  const contentType = downloadResponse.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType && contentType !== "video/mp4" && contentType !== "application/octet-stream") {
    throw new VideoGenerationProviderError("Google's download link did not return an MP4 video.");
  }
  const bytes = Buffer.from(await downloadResponse.arrayBuffer());
  validateMp4(bytes);
  return bytes;
}

export async function generateGoogleOmniVideoBytes(
  input: VideoGenerationInput,
  dependencies: ProviderDependencies = {},
): Promise<Buffer> {
  const apiKey = dependencies.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new VideoGenerationProviderError(
      "Google video generation is not configured. Add GEMINI_API_KEY in workspace secrets.",
      503,
    );
  }
  const prompt = input.prompt.trim();
  const durationSeconds = input.durationSeconds ?? 5;
  const aspectRatio = input.aspectRatio ?? "16:9";
  const resolution = input.resolution ?? "720p";
  if (!prompt || prompt.length > 3_000) {
    throw new VideoGenerationProviderError("Enter a video prompt between 1 and 3,000 characters.", 400);
  }
  if (!Number.isInteger(durationSeconds) || durationSeconds < 3 || durationSeconds > 15) {
    throw new VideoGenerationProviderError("Choose a clip duration from 3 to 15 seconds.", 400);
  }
  if (!["16:9", "9:16"].includes(aspectRatio) || !["720p", "1080p"].includes(resolution)) {
    throw new VideoGenerationProviderError("Choose a supported video orientation and resolution.", 400);
  }

  const model = dependencies.model?.trim()
    || process.env.GEMINI_VIDEO_MODEL?.trim()
    || DEFAULT_GOOGLE_VIDEO_MODEL;
  const fetcher = dependencies.fetcher ?? fetch;
  const signal = AbortSignal.any([
    AbortSignal.timeout(5 * 60_000),
    ...(input.signal ? [input.signal] : []),
  ]);
  const content: Array<Record<string, string>> = [];
  if (input.referenceImage) {
    content.push({
      type: "image",
      mime_type: input.referenceImage.mimeType,
      data: input.referenceImage.data,
    });
  }
  content.push({ type: "text", text: prompt });

  const response = await fetcher(GOOGLE_INTERACTIONS_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      model,
      input: content,
      response_format: {
        type: "video",
        aspect_ratio: aspectRatio,
        resolution,
        duration: `${durationSeconds}s`,
        delivery: "uri",
      },
    }),
    signal,
  });
  if (!response.ok) throw await readGoogleVideoError(response);

  const result = await response.json() as {
    status?: string;
    steps?: Array<{
      type?: string;
      content?: Array<{ type?: string; mime_type?: string; data?: string; uri?: string }>;
    }>;
  };
  if (result.status && result.status !== "completed") {
    throw new VideoGenerationProviderError("Google did not complete the video request.");
  }
  const video = result.steps
    ?.filter((step) => step.type === "model_output")
    .flatMap((step) => step.content ?? [])
    .find((item) => item.type === "video");
  if (!video) {
    throw new VideoGenerationProviderError("Google completed the request but returned no video.");
  }
  if (video.mime_type && video.mime_type !== "video/mp4") {
    throw new VideoGenerationProviderError("Google returned a video format this studio cannot play.");
  }

  const inlineBytes = asVideoBytes(video.data);
  const bytes = inlineBytes ?? (video.uri
    ? await downloadGoogleHostedVideo(
        video.uri,
        apiKey,
        fetcher,
        signal,
        dependencies.wait ?? defaultWait,
      )
    : null);
  if (!bytes) {
    throw new VideoGenerationProviderError("Google returned no downloadable video.");
  }
  validateMp4(bytes);
  return bytes;
}

export async function submitVideoGeneration(
  input: VideoGenerationInput,
  dependencies: ProviderDependencies = {},
): Promise<VideoGenerationResult> {
  const configuredProvider = process.env.VIDEO_PROVIDER?.trim().toLowerCase();
  if (configuredProvider && configuredProvider !== "google-omni") {
    throw new VideoGenerationProviderError(
      "The configured video provider is not supported. Set VIDEO_PROVIDER to google-omni.",
      503,
    );
  }
  const releaseAdmission = (dependencies.admission ?? defaultVideoAdmission).acquire();
  try {
    const bytes = await generateGoogleOmniVideoBytes(input, dependencies);
    const directory = await mkdtemp(join(tmpdir(), "frame-faith-google-video-"));
    const localPath = join(directory, "generated.mp4");
    try {
      await writeFile(localPath, bytes, { flag: "wx" });
      const objectPath = await (dependencies.persist
        ? dependencies.persist(localPath, input.signal)
        : storePrivateMedia(localPath, "mp4", "video/mp4", input.signal));
      return {
        provider: "google-omni",
        status: "ready",
        url: objectPath.startsWith("/api/") ? objectPath : `/api/storage${objectPath}`,
        thumbnailUrl: null,
        duration: `${input.durationSeconds ?? 5}s`,
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  } finally {
    releaseAdmission();
  }
}
