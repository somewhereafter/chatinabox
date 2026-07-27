import { describe, expect, it, vi } from "vitest";
import { transcribeScribeV2 } from "../src/vps/scribe";

describe("Scribe v2 transcription", () => {
  it("sends a bounded batch request with the English hint and keyterms", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("xi-api-key")).toBe("secret");
      const body = init?.body;
      expect(body).toBeInstanceOf(FormData);
      const form = body as FormData;
      expect(form.get("model_id")).toBe("scribe_v2");
      expect(form.get("language_code")).toBe("eng");
      expect(form.get("tag_audio_events")).toBe("false");
      expect(form.get("timestamps_granularity")).toBe("none");
      expect(form.getAll("keyterms")).toEqual(["Codex", "Chatinabox"]);
      const file = form.get("file");
      expect(file).toBeInstanceOf(File);
      expect((file as File).name).toBe("voice-note.ogg");
      expect((file as File).type).toBe("audio/ogg");
      return new Response(JSON.stringify({ text: "  Ship it, bro.  " }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await expect(transcribeScribeV2({
      apiKey: "secret",
      audio: new Uint8Array([1, 2, 3]),
      fileName: "voice-note.ogg",
      mimeType: "audio/ogg",
      languageCode: "eng",
      keyterms: ["Codex", "Chatinabox"],
    }, fetcher as typeof fetch)).resolves.toBe("Ship it, bro.");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("returns safe actionable errors without exposing provider responses", async () => {
    const unauthorized = vi.fn(async () => new Response(
      JSON.stringify({ detail: { message: "sensitive upstream detail" } }),
      { status: 401 },
    ));
    await expect(transcribeScribeV2({
      apiKey: "bad-key",
      audio: new Uint8Array([1]),
      fileName: "voice-note.ogg",
      mimeType: "audio/ogg",
    }, unauthorized as typeof fetch)).rejects.toThrow(
      "Check the ElevenLabs API key",
    );

    const silent = vi.fn(async () => new Response(
      JSON.stringify({ text: "   " }),
      { status: 200 },
    ));
    await expect(transcribeScribeV2({
      apiKey: "secret",
      audio: new Uint8Array([1]),
      fileName: "voice-note.ogg",
      mimeType: "audio/ogg",
    }, silent as typeof fetch)).rejects.toThrow(
      "couldn’t hear any speech",
    );
  });
});
