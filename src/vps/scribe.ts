const SCRIBE_ENDPOINT = "https://api.elevenlabs.io/v1/speech-to-text";
const SCRIBE_TIMEOUT_MS = 90_000;
const SCRIBE_MAX_TRANSCRIPT_CHARS = 50_000;

export interface ScribeTranscriptionInput {
  readonly apiKey: string;
  readonly audio: Uint8Array;
  readonly fileName: string;
  readonly mimeType: string;
  readonly languageCode?: string;
  readonly keyterms?: readonly string[];
}

interface ScribeResponse {
  readonly text?: unknown;
}

export async function transcribeScribeV2(
  input: ScribeTranscriptionInput,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const apiKey = input.apiKey.trim();
  if (!apiKey) {
    throw new Error("Voice transcription is not configured yet.");
  }
  if (input.audio.byteLength === 0) {
    throw new Error("That voice note was empty.");
  }

  const body = new FormData();
  body.append(
    "file",
    new Blob([new Uint8Array(input.audio)], {
      type: input.mimeType || "application/octet-stream",
    }),
    input.fileName,
  );
  body.append("model_id", "scribe_v2");
  body.append("tag_audio_events", "false");
  body.append("timestamps_granularity", "none");
  const languageCode = input.languageCode?.trim();
  if (languageCode) body.append("language_code", languageCode);
  for (const term of input.keyterms ?? []) {
    body.append("keyterms", term);
  }

  let response: Response;
  try {
    response = await fetcher(SCRIBE_ENDPOINT, {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body,
      signal: AbortSignal.timeout(SCRIBE_TIMEOUT_MS),
    });
  } catch {
    throw new Error("Voice transcription could not reach ElevenLabs.");
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        "Voice transcription is not authorized. Check the ElevenLabs API key.",
      );
    }
    if (response.status === 413) {
      throw new Error("That voice note is too large to transcribe.");
    }
    if (response.status === 429) {
      throw new Error(
        "Voice transcription is temporarily rate-limited. Try again shortly.",
      );
    }
    throw new Error(
      response.status >= 500
        ? "Voice transcription is temporarily unavailable."
        : "ElevenLabs could not transcribe that voice note.",
    );
  }

  let payload: ScribeResponse;
  try {
    payload = await response.json() as ScribeResponse;
  } catch {
    throw new Error("ElevenLabs returned an invalid transcription.");
  }
  const transcript =
    typeof payload.text === "string" ? payload.text.trim() : "";
  if (!transcript) {
    throw new Error("I couldn’t hear any speech in that voice note.");
  }
  if (transcript.length > SCRIBE_MAX_TRANSCRIPT_CHARS) {
    throw new Error("That voice-note transcript is too long to send safely.");
  }
  return transcript;
}
