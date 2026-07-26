import { describe, expect, it } from "vitest";
import {
  formatFirstRunWelcome,
  formatSettingsWelcome,
} from "../src/vps/main";
import {
  DEFAULT_EXPERIENCE_PROFILE,
  patchExperienceProfile,
} from "../src/vps/experience-profile";

describe("First-run onboarding", () => {
  it("opens a conversational setup and names the two pinned control topics", () => {
    const welcome = formatFirstRunWelcome();
    expect(welcome).toContain("first conversation is setup");
    expect(welcome).toContain("keep it simple");
    expect(welcome).toContain("pin the 🔮 manager/orchestrator");
    expect(welcome).toContain("overview/dashboard topic");
    expect(welcome).toContain("overview/dashboard topic");
  });

  it("summarizes a configured profile before a settings conversation", () => {
    const profile = patchExperienceProfile(DEFAULT_EXPERIENCE_PROFILE, {
      setupComplete: true,
      assistant: { name: "mori" },
      overview: { name: "desk" },
      manager: { name: "guide", role: "orchestrator" },
    });
    const welcome = formatSettingsWelcome(profile);
    expect(welcome).toContain("Current voice · mori");
    expect(welcome).toContain("Dashboard · desk");
    expect(welcome).toContain("Manager · guide · orchestrator");
    expect(welcome).toContain("preserved across upgrades");
  });
});
