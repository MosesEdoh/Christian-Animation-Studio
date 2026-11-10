export type DialogueCharacter = {
  id: number;
  name: string;
  personality: string;
  role?: string;
};

export type DialogueTurn = {
  characterId: number;
  characterName: string;
  text: string;
};

export type CharacterVoice = {
  characterId: number;
  voiceName: string;
  style: string;
};

const GEMINI_TTS_MODEL = "gemini-3.8-flash-tts";
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
const MAX_SCENE_DIALOGUE_CHARACTERS = 16_000;
const MAX_TTS_ATTEMPTS = 3;

const VOICE_PROFILES = [
  { voiceName: "Achernar", traits: ["soft", "gentle", "kind", "quiet", "shy", "patient"] },
  { voiceName: "Vindemiatrix", traits: ["gentle", "warm", "caring", "kind", "comfort"] },
  { voiceName: "Achird", traits: ["friendly", "funny", "humor", "playful", "nervous"] },
  { voiceName: "Puck", traits: ["upbeat", "curious", "funny", "energetic", "playful"] },
  { voiceName: "Fenrir", traits: ["bold", "excitable", "brave", "adventurous", "energetic"] },
  { voiceName: "Leda", traits: ["youthful", "bright", "curious", "hopeful"] },
  { voiceName: "Kore", traits: ["firm", "determined", "protective", "leader", "confident"] },
  { voiceName: "Orus", traits: ["firm", "steady", "strong", "protective", "brave"] },
  { voiceName: "Alnilam", traits: ["firm", "serious", "resolute", "determined"] },
  { voiceName: "Charon", traits: ["informative", "wise", "mentor", "teacher", "thoughtful"] },
  { voiceName: "Rasalgethi", traits: ["informative", "wise", "mentor", "teacher", "measured"] },
  { voiceName: "Sadaltager", traits: ["knowledgeable", "inventive", "wise", "thoughtful"] },
  { voiceName: "Algenib", traits: ["gravelly", "mysterious", "shadow", "ominous"] },
  { voiceName: "Enceladus", traits: ["breathy", "mysterious", "quiet", "thoughtful"] },
  { voiceName: "Gacrux", traits: ["mature", "mentor", "steady", "wise"] },
  { voiceName: "Zephyr", traits: ["bright", "hopeful", "open", "cheerful"] },
  { voiceName: "Autonoe", traits: ["bright", "clear", "optimistic", "warm"] },
  { voiceName: "Callirrhoe", traits: ["easy-going", "relaxed", "casual", "patient"] },
  { voiceName: "Iapetus", traits: ["clear", "precise", "observant", "calm"] },
  { voiceName: "Umbriel", traits: ["easy-going", "calm", "quiet", "gentle"] },
  { voiceName: "Algieba", traits: ["smooth", "confident", "composed"] },
  { voiceName: "Despina", traits: ["smooth", "calm", "thoughtful"] },
  { voiceName: "Erinome", traits: ["clear", "direct", "honest"] },
  { voiceName: "Laomedeia", traits: ["upbeat", "lively", "encouraging"] },
  { voiceName: "Pulcherrima", traits: ["forward", "bold", "expressive"] },
  { voiceName: "Sadachbia", traits: ["lively", "energetic", "playful"] },
  { voiceName: "Schedar", traits: ["even", "steady", "calm", "patient"] },
  { voiceName: "Zubenelgenubi", traits: ["casual", "funny", "easy-going"] },
  { voiceName: "Sulafat", traits: ["warm", "kind", "reassuring"] },
] as const;

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function characterNameFromScriptLine(line: string, names: Map<string, DialogueCharacter>): DialogueCharacter | undefined {
  const candidate = line
    .trim()
    .replace(/:\s*$/, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/[.:]+$/, "")
    .trim();
  return names.get(normalizeName(candidate));
}

/**
 * Reads only screenplay dialogue markers matching a saved character. Action,
 * scene headings, and unknown names are never sent to speech generation.
 */
export function extractCharacterDialogue(
  content: string,
  characters: DialogueCharacter[],
): DialogueTurn[] {
  if (!content || content.length > MAX_SCENE_DIALOGUE_CHARACTERS || !characters.length) return [];
  const names = new Map(characters.map(character => [normalizeName(character.name), character]));
  const turns: DialogueTurn[] = [];
  let active: DialogueCharacter | undefined;
  let activeText: string[] = [];

  const flush = () => {
    const text = activeText.join(" ").replace(/\s+/g, " ").trim();
    if (active && text) {
      turns.push({ characterId: active.id, characterName: active.name, text });
    }
    active = undefined;
    activeText = [];
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      flush();
      continue;
    }
    const inline = /^([^:]{1,80}):\s*(.+)$/.exec(line);
    if (inline) {
      flush();
      const character = names.get(normalizeName(inline[1]!));
      if (character) {
        turns.push({
          characterId: character.id,
          characterName: character.name,
          text: inline[2]!.trim(),
        });
      }
      continue;
    }

    const marker = characterNameFromScriptLine(line, names);
    if (marker) {
      flush();
      active = marker;
      continue;
    }

    // Parenthetical delivery cues belong to the voice style, not the spoken line.
    if (/^\([^)]*\)$/.test(line)) continue;
    if (active && !/^(?:INT\.|EXT\.|CUT TO:|FADE OUT)/i.test(line)) {
      activeText.push(line);
    } else {
      flush();
    }
  }
  flush();
  return turns.filter(turn => turn.text.length > 0);
}

function matchedTraits(character: DialogueCharacter): string[] {
  const description = `${character.personality} ${character.role ?? ""} ${character.name}`.toLocaleLowerCase();
  const matches = VOICE_PROFILES.flatMap(profile => {
    const score = profile.traits.reduce((total, trait) => total + Number(description.includes(trait)), 0);
    return score ? [{ voiceName: profile.voiceName, score }] : [];
  });
  return matches.sort((left, right) => right.score - left.score).map(match => match.voiceName);
}

export function assignCharacterVoices(characters: DialogueCharacter[]): Map<number, CharacterVoice> {
  const ordered = [...characters].sort((left, right) => left.id - right.id);
  const assigned = new Map<number, CharacterVoice>();
  const used = new Set<string>();
  for (const character of ordered) {
    const preferences = matchedTraits(character);
    const voiceName = [
      ...preferences,
      ...VOICE_PROFILES.map(profile => profile.voiceName),
    ].find(candidate => !used.has(candidate)) ?? VOICE_PROFILES[ordered.indexOf(character) % VOICE_PROFILES.length]!.voiceName;
    used.add(voiceName);
    const personality = character.personality.trim().replace(/\s+/g, " ").slice(0, 220);
    const role = character.role?.trim().replace(/\s+/g, " ").slice(0, 100);
    assigned.set(character.id, {
      characterId: character.id,
      voiceName,
      style: [
        personality ? `Speak with this character's personality: ${personality}.` : "",
        role ? `Character role: ${role}.` : "",
        "Use a natural, distinct, age-appropriate performance; do not exaggerate or parody the character.",
      ].filter(Boolean).join(" ").slice(0, 600),
    });
  }
  return assigned;
}

type AudioPart = { inlineData?: { data?: string; mimeType?: string } };
type TtsResponse = {
  candidates?: Array<{ content?: { parts?: AudioPart[] } }>;
  error?: { message?: string };
};

function dialogueGroups(turns: DialogueTurn[], voices: Map<number, CharacterVoice>): DialogueTurn[][] {
  const groups: DialogueTurn[][] = [];
  let current: DialogueTurn[] = [];
  let speakers = new Set<number>();
  for (const turn of turns) {
    if (!voices.has(turn.characterId)) continue;
    if (!speakers.has(turn.characterId) && speakers.size === 2) {
      groups.push(current);
      current = [];
      speakers = new Set<number>();
    }
    current.push(turn);
    speakers.add(turn.characterId);
  }
  if (current.length) groups.push(current);
  return groups;
}

async function synthesizeGroup(
  turns: DialogueTurn[],
  voices: Map<number, CharacterVoice>,
  signal?: AbortSignal,
): Promise<Buffer> {
  const speakers = [...new Set(turns.map(turn => turn.characterId))];
  const voiceFor = (characterId: number) => {
    const voice = voices.get(characterId);
    if (!voice) throw new Error("A spoken character has no assigned voice.");
    return voice;
  };
  const parts = turns.map(turn => {
    const voice = voiceFor(turn.characterId);
    return {
      text: turn.text,
      speech_metadata: { speaker: turn.characterName, style: voice.style },
    };
  });
  const speechConfig = speakers.length === 1
    ? { voiceConfig: { voice: voiceFor(speakers[0]!).voiceName } }
    : {
        multiSpeakerVoiceConfig: {
          speakerVoiceConfigs: speakers.map(characterId => {
            const character = turns.find(turn => turn.characterId === characterId)!;
            return {
              speaker: character.characterName,
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: voiceFor(characterId).voiceName },
              },
            };
          }),
        },
      };
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Character voice generation is not configured.");
  let response: Response | undefined;
  for (let attempt = 0; attempt < MAX_TTS_ATTEMPTS; attempt += 1) {
    signal?.throwIfAborted();
    try {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TTS_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts }],
            generationConfig: { responseModalities: ["AUDIO"], speechConfig },
          }),
          signal: AbortSignal.any([
            AbortSignal.timeout(90_000),
            ...(signal ? [signal] : []),
          ]),
        },
      );
      if (response.ok) break;
      if (![429, 500, 503].includes(response.status) || attempt === MAX_TTS_ATTEMPTS - 1) break;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (attempt === MAX_TTS_ATTEMPTS - 1) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 800 * (attempt + 1)));
  }
  if (!response?.ok) {
    const errorText = await response?.text().catch(() => "");
    throw new Error(`Gemini character voice generation failed${response ? ` (${response.status})` : ""}${errorText ? `: ${errorText.slice(0, 300)}` : "."}`);
  }
  const payload = await response.json() as TtsResponse;
  const audio = payload.candidates?.[0]?.content?.parts?.find(part => part.inlineData?.data)?.inlineData;
  if (!audio?.data || !audio.mimeType?.toLowerCase().includes("wav")) {
    throw new Error("Gemini did not return a playable WAV file for character dialogue.");
  }
  const bytes = Buffer.from(audio.data, "base64");
  if (!bytes.length || bytes.length > MAX_AUDIO_BYTES || bytes.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("Gemini returned an invalid or oversized character dialogue track.");
  }
  return bytes;
}

/** Generates one WAV voice track for a scene, preserving dialogue order. */
export async function generateCharacterDialogueAudio(
  content: string,
  characters: DialogueCharacter[],
  signal?: AbortSignal,
): Promise<Buffer | undefined> {
  const turns = extractCharacterDialogue(content, characters);
  if (!turns.length) return undefined;
  const voices = assignCharacterVoices(characters);
  const chunks: Buffer[] = [];
  for (const group of dialogueGroups(turns, voices)) {
    chunks.push(await synthesizeGroup(group, voices, signal));
  }
  if (chunks.length === 1) return chunks[0];

  // Multiple TTS calls are used only when a scene has more than two speakers.
  // Preserve the returned WAV chunks as a simple sequence using the same
  // single-channel PCM format Gemini TTS emits.
  const parsed = chunks.map(parsePcmWav);
  const first = parsed[0]!;
  if (parsed.some(part => part.sampleRate !== first.sampleRate || part.channels !== first.channels || part.bitsPerSample !== first.bitsPerSample)) {
    throw new Error("Gemini returned incompatible audio chunks for this scene.");
  }
  const pcm = Buffer.concat(parsed.map(part => part.pcm));
  return makePcmWav(pcm, first.sampleRate, first.channels, first.bitsPerSample);
}

function parsePcmWav(wav: Buffer): { pcm: Buffer; sampleRate: number; channels: number; bitsPerSample: number } {
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Gemini returned a malformed WAV dialogue track.");
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let pcm: Buffer | undefined;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = Math.min(wav.length, start + size);
    if (id === "fmt " && size >= 16) {
      channels = wav.readUInt16LE(start + 2);
      sampleRate = wav.readUInt32LE(start + 4);
      bitsPerSample = wav.readUInt16LE(start + 14);
    } else if (id === "data") {
      pcm = wav.subarray(start, end);
    }
    offset = start + size + (size % 2);
  }
  if (!pcm || !sampleRate || !channels || bitsPerSample !== 16) {
    throw new Error("Gemini returned an unsupported WAV dialogue format.");
  }
  return { pcm, sampleRate, channels, bitsPerSample };
}

function makePcmWav(pcm: Buffer, sampleRate: number, channels: number, bitsPerSample: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28);
  header.writeUInt16LE(channels * bitsPerSample / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
