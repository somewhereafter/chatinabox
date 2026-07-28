import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("Telegram API backoff", () => {
  it("allows legacy fallback only after an explicit rich-message rejection", async () => {
    const { tgCanFallbackAfterRichFailure } = await import("../src/telegram");

    expect(tgCanFallbackAfterRichFailure(null)).toBe(false);
    expect(tgCanFallbackAfterRichFailure({
      ok: false,
      result: undefined,
      error_code: 429,
    })).toBe(false);
    expect(tgCanFallbackAfterRichFailure({
      ok: false,
      result: undefined,
      error_code: 500,
    })).toBe(false);
    expect(tgCanFallbackAfterRichFailure({
      ok: false,
      result: undefined,
      error_code: 400,
      description: "Bad Request: can't parse rich message",
    })).toBe(true);
  });

  it("honors retry_after without hammering Telegram during the quiet window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T04:00:00Z"));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        json: async () => ({
          ok: false,
          error_code: 429,
          description: "Too Many Requests",
          parameters: { retry_after: 2 },
        }),
      })
      .mockResolvedValueOnce({
        json: async () => ({
          ok: true,
          result: { message_id: 99 },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { tgSend } = await import("../src/telegram");
    const env = { TG_BOT_TOKEN: "test-token" };

    expect((await tgSend(env, 1, "first")).error_code).toBe(429);
    expect((await tgSend(env, 1, "too soon")).error_code).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_251);
    expect((await tgSend(env, 1, "after backoff")).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("paces group-message recovery after Telegram invokes flood control", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T04:00:00Z"));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        json: async () => ({
          ok: false,
          error_code: 429,
          description: "Too Many Requests",
          parameters: { retry_after: 1 },
        }),
      })
      .mockResolvedValue({
        json: async () => ({
          ok: true,
          result: { message_id: fetchMock.mock.calls.length },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { tgSend } = await import("../src/telegram");
    const env = { TG_BOT_TOKEN: "test-token" };

    expect((await tgSend(env, -10042, "limited")).error_code).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_251);
    expect((await tgSend(env, -10042, "recovered")).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await tgSend(env, -10042, "too soon")).error_code).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(3_101);
    expect((await tgSend(env, -10042, "paced")).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("Telegram identity", () => {
  it("uses native bot and forum identity methods", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ ok: true, result: true }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const {
      tgSetChatPhoto,
      tgSetChatTitle,
      tgSetMyName,
      tgSetMyProfilePhoto,
    } = await import("../src/telegram");
    const env = { TG_BOT_TOKEN: "test-token" };
    const photo = new Blob(["jpeg"], { type: "image/jpeg" });

    await tgSetMyName(env, "mori");
    await tgSetMyProfilePhoto(env, photo);
    await tgSetChatTitle(env, -10042, "night shift");
    await tgSetChatPhoto(env, -10042, photo);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://api.telegram.org/bottest-token/setMyName",
      "https://api.telegram.org/bottest-token/setMyProfilePhoto",
      "https://api.telegram.org/bottest-token/setChatTitle",
      "https://api.telegram.org/bottest-token/setChatPhoto",
    ]);
    const botPhoto = fetchMock.mock.calls[1]?.[1]?.body as FormData;
    expect(botPhoto.get("photo")).toContain("attach://profile_photo");
    expect(botPhoto.get("profile_photo")).toBeInstanceOf(Blob);
    const groupPhoto = fetchMock.mock.calls[3]?.[1]?.body as FormData;
    expect(groupPhoto.get("chat_id")).toBe("-10042");
    expect(groupPhoto.get("photo")).toBeInstanceOf(Blob);
  });
});
