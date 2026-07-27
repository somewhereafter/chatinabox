import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPERIENCE_PROFILE,
  ExperienceProfileProvider,
  normalizeExperienceProfile,
  patchExperienceProfile,
  readExperienceProfile,
  writeExperienceProfile,
} from "../src/vps/experience-profile";

describe("Experience profile", () => {
  it("ships neutral first-run defaults while retaining the manager orb", () => {
    expect(DEFAULT_EXPERIENCE_PROFILE).toMatchObject({
      setupComplete: false,
      assistant: { name: "codex", mark: "⌁", photoPath: "" },
      overview: {
        name: "overview",
        emoji: "◉",
        groupName: "codex workspace",
        groupPhotoPath: "",
      },
      manager: {
        name: "orchestrator",
        topicIconEmoji: "🔮",
      },
    });
  });

  it("keeps a custom identity in configuration rather than product code", () => {
    const profile = patchExperienceProfile(DEFAULT_EXPERIENCE_PROFILE, {
      setupComplete: true,
      assistant: {
        name: "mori",
        mark: "✦",
        photoPath: "/var/lib/chatinabox/profile-assets/assistant.jpg",
      },
      overview: {
        name: "desk",
        emoji: "◉",
        groupName: "night shift",
        groupPhotoPath: "/var/lib/chatinabox/profile-assets/group.jpg",
      },
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
      assistant: {
        name: "mori",
        mark: "✦",
        photoPath: "/var/lib/chatinabox/profile-assets/assistant.jpg",
      },
      overview: {
        name: "desk",
        emoji: "◉",
        groupName: "night shift",
        groupPhotoPath: "/var/lib/chatinabox/profile-assets/group.jpg",
      },
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

  it("does not invent a Telegram group name for an older private profile", () => {
    const legacy = {
      ...DEFAULT_EXPERIENCE_PROFILE,
      overview: { name: "nexus", emoji: "🪐" },
    };
    const profile = normalizeExperienceProfile(legacy);
    expect(profile.overview.groupName).toBe("");
  });
});
