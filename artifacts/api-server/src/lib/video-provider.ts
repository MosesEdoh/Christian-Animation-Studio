export type VideoProviderName = "mock" | "runway" | "luma" | "pika";

type VideoGenerationInput = {
  prompt: string;
  referenceImageUrl?: string | null;
};

export type VideoGenerationResult = {
  provider: VideoProviderName;
  status: "queued" | "generating" | "ready";
  url: string | null;
  thumbnailUrl: string | null;
  duration: string;
};

function configuredProvider(): VideoProviderName {
  const provider = (process.env.VIDEO_PROVIDER ?? "mock").toLowerCase();
  if (provider === "runway" || provider === "luma" || provider === "pika") {
    return provider;
  }
  return "mock";
}

export async function submitVideoGeneration(
  input: VideoGenerationInput,
): Promise<VideoGenerationResult> {
  const provider = configuredProvider();

  if (provider === "mock") {
    throw new Error("Video generation is not configured. Mock jobs do not produce video. Use storyboard movie export or configure a real provider.");
  }

  const apiKey = process.env.VIDEO_API_KEY;
  const apiUrl = process.env.VIDEO_API_URL;
  if (!apiKey || !apiUrl) {
    throw new Error(
      `VIDEO_API_KEY and VIDEO_API_URL are required for the ${provider} provider`,
    );
  }

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "X-Video-Provider": provider,
    },
    body: JSON.stringify({
      prompt: input.prompt,
      ...(input.referenceImageUrl
        ? { referenceImageUrl: input.referenceImageUrl }
        : {}),
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(
      `${provider} video request failed (${response.status}): ${message}`,
    );
  }

  const payload = (await response.json()) as {
    id?: string;
    url?: string;
    thumbnailUrl?: string;
    duration?: string;
  };

  return {
    provider,
    status: payload.url ? "ready" : "generating",
    url: payload.url ?? null,
    thumbnailUrl: payload.thumbnailUrl ?? null,
    duration: payload.duration ?? "00:04",
  };
}