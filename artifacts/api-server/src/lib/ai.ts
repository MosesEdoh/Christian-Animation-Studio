const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.6-flash";

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
};

export async function generateGeminiText(
  prompt: string,
  responseMimeType?: "application/json",
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  let response: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.72,
            maxOutputTokens: 8192,
            ...(responseMimeType ? { responseMimeType } : {}),
          },
        }),
      },
    );
    if (response.ok) break;
    if (response.status !== 429 && response.status !== 503) break;
    await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
  }

  if (!response?.ok) {
    const message = await response?.text();
    throw new Error(`Gemini request failed (${response?.status}): ${message}`);
  }

  const payload = (await response.json()) as GeminiResponse;
  const text = payload.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? "")
    .join("")
    .trim();

  if (!text) {
    throw new Error("Gemini returned an empty response");
  }

  return text;
}

export async function generateGeminiJson<T>(prompt: string): Promise<T> {
  const text = await generateGeminiText(prompt, "application/json");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("Gemini returned invalid JSON");
  }
}