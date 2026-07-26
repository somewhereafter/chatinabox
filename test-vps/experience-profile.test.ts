import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPERIENCE_PROFILE,
  ExperienceProfileProvider,
  patchExperienceProfile,
  readExperienceProfile,
  writeExperienceProfile,
} from "../src/vps/experience-profile";

describe("Experience profile", () => {
  it("ships neutral first-run defaults while retaining the manager orb", () => {
    expect(DEFAULT_EXPERIENCE_PROFILE).toMatchObject({
      setupComplete: false,
      assistant: { name: "codex", mark: "⌁" },
      overview: { name: "overview", emoji: "◉" },
      manager: {
        name: "orchestrator",
        topicIconEmoji: "🔮",
      },
    });
  });

  it("keeps a custom identity in configuration rather than product code", () => {
    const profile = patchExperienceProfile(DEFAULT_EXPERIENCE_PROFILE, {
      setupComplete: true,
      assistant: { name: "mori", mark: "✦" },
      overview: { name: "desk", emoji: "◉" },
      manager: {
        name: "Mori",
        emoji: "🪄",
        role: "orchestrator",
        topicName: "🪄 Mori · orchestrator",
        cwd: "/var/lib/chatinabox-bridge/mori",
        model: "sol",
        reasoningEffort: "high",
      },
    });

    expect(profile).toMatchObject({
      setupComplete: true,
      assistant: { name: "mori", mark: "✦" },
      overview: { name: "desk", emoji: "◉" },
      manager: {
        name: "Mori",
        topicIconEmoji: "🔮",
        model: "sol",
        reasoningEffort: "high",
      },
    });
  });

  it("round-trips and hot-reloads the private profile", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chatinabox-profile-"));
    const profilePath = path.join(root, "profile.json");
    try {
      writeExperienceProfile(profilePath, DEFAULT_EXPERIENCE_PROFILE);
      const provider = new ExperienceProfileProvider(profilePath);
      expect(provider.current().assistant.name).toBe("codex");
      const personalized = patchExperienceProfile(provider.current(), {
        assistant: { name: "quiet guide" },
      });
      writeExperienceProfile(profilePath, personalized);
      expect(readExperienceProfile(profilePath).assistant.name)
        .toBe("quiet guide");
      expect(provider.current().assistant.name).toBe("quiet guide");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
