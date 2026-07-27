import { describe, expect, it } from "vitest";
import { parseCodexThreadGoal } from "../src/vps/codex-app-server";

describe("Codex app-server goal adapter", () => {
  it("accepts the native goal shape and rejects partial or unknown state", () => {
    expect(parseCodexThreadGoal({
      threadId: "thread-1",
      objective: "Ship goal sync",
      status: "paused",
      tokenBudget: 50_000,
      tokensUsed: 12_345,
      timeUsedSeconds: 90,
      createdAt: 100,
      updatedAt: 200,
    })).toEqual({
      threadId: "thread-1",
      objective: "Ship goal sync",
      status: "paused",
      tokenBudget: 50_000,
      tokensUsed: 12_345,
      timeUsedSeconds: 90,
      createdAt: 100,
      updatedAt: 200,
    });
    expect(parseCodexThreadGoal({
      threadId: "thread-1",
      objective: "Ship goal sync",
      status: "invented",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 100,
      updatedAt: 200,
    })).toBeNull();
    expect(parseCodexThreadGoal({ threadId: "thread-1" })).toBeNull();
  });
});
