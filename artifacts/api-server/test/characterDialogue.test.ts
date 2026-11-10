import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import {
  assignCharacterVoices,
  extractCharacterDialogue,
  generateCharacterDialogueAudio,
  type DialogueCharacter,
} from "../src/lib/characterDialogue";

const cast: DialogueCharacter[] = [
  { id: 1, name: "Mara", role: "Protective lead", personality: "Observant, funny when nervous, fiercely protective." },
  { id: 2, name: "Jonah", role: "Steady friend", personality: "Patient, inventive, and quietly brave." },
  { id: 3, name: "Ms. Ada", role: "Mentor", personality: "Warm, thoughtful, and reassuring." },
];

function wavFixture(sampleCount = 1200): Buffer {
  const pcm = Buffer.alloc(sampleCount * 2);
  for (let sample = 0; sample < sampleCount; sample += 1) {
    pcm.writeInt16LE(Math.round(Math.sin(sample / 8) * 9000), sample * 2);
  }
  const wav = Buffer.alloc(44);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24_000, 24);
  wav.writeUInt32LE(48_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([wav, pcm]);
}

function ttsResponse() {
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/wav", data: wavFixture().toString("base64") } }] } }],
  }), { headers: { "content-type": "application/json" } });
}

let previousApiKey: string | undefined;
afterEach(() => {
  mock.restoreAll();
  if (previousApiKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = previousApiKey;
});

test("extracts only saved-character screenplay dialogue and ignores action", () => {
  const turns = extractCharacterDialogue(
    [
      "INT. SCHOOL HALLWAY — LATE AFTERNOON",
      "",
      "MARA",
      "(quietly)",
      "You do not have to carry all of that by yourself.",
      "",
      "A locker door shudders at the far end of the hall.",
      "",
      "JONAH: The light is not a weapon.",
      "",
      "UNKNOWN STUDENT",
      "Keep this secret from every adult.",
    ].join("\n"),
    cast,
  );
  assert.deepEqual(turns, [
    { characterId: 1, characterName: "Mara", text: "You do not have to carry all of that by yourself." },
    { characterId: 2, characterName: "Jonah", text: "The light is not a weapon." },
  ]);
});

test("assigns distinct stable voices informed by character personality", () => {
  const first = assignCharacterVoices(cast);
  const second = assignCharacterVoices([...cast].reverse());
  assert.equal(first.get(2)?.voiceName, second.get(2)?.voiceName);
  assert.equal(first.get(3)?.voiceName, "Charon");
  assert.equal(new Set([...first.values()].map(voice => voice.voiceName)).size, cast.length);
  assert.match(first.get(1)?.style ?? "", /protective/i);
});

test("requests multi-speaker speech with distinct voice and style metadata", async () => {
  previousApiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return ttsResponse();
  });

  const result = await generateCharacterDialogueAudio(
    "MARA\nI can stay with him.\n\nJONAH\nI will get Ms. Ada.",
    cast,
  );

  assert.ok(result?.length);
  assert.equal(result?.toString("ascii", 0, 4), "RIFF");
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /gemini-3\.8-flash-tts:generateContent/);
  const body = calls[0]!.body;
  const config = body.generationConfig as { responseModalities: string[]; speechConfig: Record<string, unknown> };
  assert.deepEqual(config.responseModalities, ["AUDIO"]);
  const speech = config.speechConfig.multiSpeakerVoiceConfig as {
    speakerVoiceConfigs: Array<{ speaker: string; voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } }>;
  };
  assert.deepEqual(speech.speakerVoiceConfigs.map(voice => voice.speaker), ["Mara", "Jonah"]);
  assert.notEqual(
    speech.speakerVoiceConfigs[0]!.voiceConfig.prebuiltVoiceConfig.voiceName,
    speech.speakerVoiceConfigs[1]!.voiceConfig.prebuiltVoiceConfig.voiceName,
  );
  const parts = ((body.contents as Array<{ parts: Array<{ speech_metadata: { speaker: string; style: string } }> }>)[0]!).parts;
  assert.deepEqual(parts.map(part => part.speech_metadata.speaker), ["Mara", "Jonah"]);
  assert.ok(parts.every(part => part.speech_metadata.style.length > 0));
});

test("splits scenes above two speakers into sequential supported voice groups", async () => {
  previousApiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";
  let calls = 0;
  mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return ttsResponse();
  });

  const result = await generateCharacterDialogueAudio(
    "MARA\nHello.\n\nJONAH\nHi.\n\nMS. ADA\nI am here.",
    cast,
  );
  assert.equal(calls, 2);
  assert.ok(result);
  assert.equal(result.toString("ascii", 0, 4), "RIFF");
  assert.equal(result.length, 44 + 2 * 1200 * 2);
});

