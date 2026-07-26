import { describe, expect, it } from "vitest";
import { isTelegramUserAllowed } from "../src/security";

describe("Telegram ownership policy", () => {
  it("fails closed and matches only exact numeric owner IDs", () => {
    expect(isTelegramUserAllowed(undefined, 42)).toBe(false);
    expect(isTelegramUserAllowed("", 42)).toBe(false);
    expect(isTelegramUserAllowed("*", 42)).toBe(false);
    expect(isTelegramUserAllowed("42,43", 42)).toBe(true);
    expect(isTelegramUserAllowed("42,43", 4)).toBe(false);
    expect(isTelegramUserAllowed("42,bad", 42)).toBe(false);
  });
});
