import { describe, expect, it } from "vitest";
import { loadCatinaboxEnv } from "../src/vps/env";

describe("loadCatinaboxEnv", () => {
  it("loads an owner-only environment with portable defaults", () => {
    const env = loadCatinaboxEnv({
      TG_BOT_TOKEN: "123:secret",
      TG_ALLOWED_USER_IDS: "42",
      CATINABOX_DATA_DIR: "/tmp/catinabox",
      CATINABOX_DEFAULT_CWD: "/srv/work",
    });
    expect(env).toMatchObject({
      TG_BOT_TOKEN: "123:secret",
      TG_ALLOWED_USER_IDS: "42",
      DATA_DIR: "/tmp/catinabox",
      DEFAULT_CWD: "/srv/work",
    });
  });

  it("rejects a missing token and wildcard ownership", () => {
    expect(() => loadCatinaboxEnv({
      TG_ALLOWED_USER_IDS: "42",
    })).toThrow(/TG_BOT_TOKEN/u);
    expect(() => loadCatinaboxEnv({
      TG_BOT_TOKEN: "123:secret",
      TG_ALLOWED_USER_IDS: "*",
    })).toThrow(/numeric Telegram user ID/u);
  });
});
