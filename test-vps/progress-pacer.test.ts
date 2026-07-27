import { describe, expect, it } from "vitest";
import { TelegramProgressPacer } from "../src/vps/progress-pacer";

describe("Telegram progress pacing", () => {
  it("paces each topic and the shared forum without coupling private chats", () => {
    const pacer = new TelegramProgressPacer(5_000, 3_200, 1_000);
    const start = 1_800_000_000_000;

    expect(pacer.tryAcquire(-1001, 10, start)).toBe(true);
    expect(pacer.tryAcquire(-1001, 10, start + 3_201)).toBe(false);
    expect(pacer.tryAcquire(-1001, 11, start + 3_201)).toBe(true);
    expect(pacer.tryAcquire(-1001, 10, start + 5_001)).toBe(false);
    expect(pacer.tryAcquire(-1001, 10, start + 6_402)).toBe(true);

    expect(pacer.tryAcquire(42, 0, start)).toBe(true);
    expect(pacer.tryAcquire(43, 0, start)).toBe(true);
    expect(pacer.tryAcquire(42, 0, start + 1_001)).toBe(false);
    expect(pacer.tryAcquire(42, 1, start + 1_001)).toBe(true);
  });
});
