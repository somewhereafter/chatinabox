import { describe, expect, it } from "vitest";
import { bridgeRequestTimeoutMs } from "../src/vps/codex-bridge-client";

describe("Codex bridge client timeouts", () => {
  it.each(["new", "resume", "lobby"] as const)(
    "allows %s startup to outlive ordinary bridge calls",
    (op) => {
      expect(bridgeRequestTimeoutMs({ op })).toBe(360_000);
    },
  );

  it("keeps quick local calls on the short failure deadline", () => {
    expect(bridgeRequestTimeoutMs({ op: "list" })).toBe(3_000);
  });

  it("allows prompt delivery to wait for Codex acceptance", () => {
    expect(bridgeRequestTimeoutMs({ op: "send" })).toBe(10_000);
  });

  it("does not shorten an explicitly longer caller deadline", () => {
    expect(bridgeRequestTimeoutMs({ op: "resume" }, 420_000)).toBe(420_000);
  });
});
