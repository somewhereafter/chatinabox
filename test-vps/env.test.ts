import { describe, expect, it } from "vitest";
import { loadChatinaboxEnv } from "../src/vps/env";

describe("loadChatinaboxEnv", () => {
  it("loads an owner-only environment with portable defaults", () => {
    const env = loadChatinaboxEnv({
      TG_BOT_TOKEN: "123:secret",
      TG_ALLOWED_USER_IDS: "42",
      CHATINABOX_DATA_DIR: "/tmp/chatinabox",
      CHATINABOX_DEFAULT_CWD: "/srv/work",
      ELEVENLABS_API_KEY: "scribe-secret",
      CHATINABOX_SCRIBE_LANGUAGE: "eng",
      CHATINABOX_SCRIBE_KEYTERMS:
        "Chatinabox,Codex,Codex,bad[term],a b c d e f",
    });
    expect(env).toMatchObject({
      TG_BOT_TOKEN: "123:secret",
      TG_ALLOWED_USER_IDS: "42",
      DATA_DIR: "/tmp/chatinabox",
      DEFAULT_CWD: "/srv/work",
      ELEVENLABS_API_KEY: "scribe-secret",
      SCRIBE_LANGUAGE_CODE: "eng",
      SCRIBE_KEYTERMS: ["Chatinabox", "Codex"],
    });
  });

  it("rejects a missing token and wildcard ownership", () => {
    expect(() => loadChatinaboxEnv({
      TG_ALLOWED_USER_IDS: "42",
    })).toThrow(/TG_BOT_TOKEN/u);
    expect(() => loadChatinaboxEnv({
      TG_BOT_TOKEN: "123:secret",
      TG_ALLOWED_USER_IDS: "*",
    })).toThrow(/numeric Telegram user ID/u);
  });
});
