import { describe, expect, it } from "vitest";
import {
  formatOverviewDashboard,
  overviewThreadId,
  overviewRenderSignature,
  overviewStatsFromBridge,
} from "../src/vps/overview";
import {
  DEFAULT_EXPERIENCE_PROFILE,
  patchExperienceProfile,
} from "../src/vps/experience-profile";

const customProfile = patchExperienceProfile(DEFAULT_EXPERIENCE_PROFILE, {
  setupComplete: true,
  overview: { name: "desk", emoji: "◉" },
});

describe("Overview dashboard", () => {
  it("omits Telegram's thread field for a forum General topic", () => {
    expect(overviewThreadId({})).toBe(0);
    expect(overviewThreadId({ message_thread_id: 42 })).toBe(42);
  });

  it("excludes the Lobby and splits running workers into working and idle", () => {
    const stats = overviewStatsFromBridge({
      ok: true,
      totalSessions: 50,
      recent: [],
      usage: null,
      panes: [
        pane("🪄 Lobby", "Lobby", false),
        pane("Research", "Sol", true),
        pane("Build", "Terra", false),
      ],
    });

    expect(stats).toMatchObject({
      total: 50,
      active: 2,
      working: 1,
      idle: 1,
      bridgeOnline: true,
    });
  });

  it("renders a rich, timestamped usage card and stable data signature", () => {
    const stats = {
      total: 50,
      active: 2,
      working: 1,
      idle: 1,
      bridgeOnline: true,
      usage: {
        observedAt: Date.parse("2026-07-26T18:36:29.692Z"),
        planType: "pro",
        creditsBalance: "5000",
        limits: [{
          usedPercent: 38,
          windowMinutes: 10080,
          resetsAt: 1785611896,
        }],
      },
    } as const;
    const card = formatOverviewDashboard(
      stats,
      Date.parse("2026-07-26T19:00:00.000Z"),
      customProfile,
    );

    expect(card).toContain("<mark>desk ◉ · 🟢 live</mark>");
    expect(card).toContain("<p><b>sessions</b></p><blockquote>");
    expect(card).toContain("<p><b>usage limits</b></p><blockquote>");
    expect(card).toContain("🗂 <b>50</b> total");
    expect(card).toContain("🟢 <b>2</b> active");
    expect(card).toContain("⚡ <b>1</b> working");
    expect(card).toContain("💤 <b>1</b> idle");
    expect(card).toContain(
      "🗂 <b>50</b> total<br/>🟢 <b>2</b> active<br/>",
    );
    expect(card).not.toContain("├");
    expect(card).not.toContain("└");
    expect(card).not.toContain("<pre>");
    expect(card).toContain("<b>weekly</b><br/><code>");
    expect(card).toContain("<b>62% remaining</b><br/>↻ resets");
    expect(card).toContain("weekly");
    expect(card).toContain("26 jul 2026 · 19:00 utc");
    expect(card).toContain("<footer>synced");
    expect(overviewRenderSignature(stats)).toBe(overviewRenderSignature({
      ...stats,
      usage: { ...stats.usage, observedAt: stats.usage.observedAt + 5_000 },
    }));
  });

  it("renders current goals and expandable recent completions", () => {
    const now = Date.parse("2026-07-26T19:00:00.000Z");
    const card = formatOverviewDashboard(
      {
        total: 2,
        active: 1,
        working: 1,
        idle: 0,
        bridgeOnline: true,
        usage: null,
      },
      now,
      customProfile,
      {
        current: [{
          chat_id: -10042,
          owner_user_id: 42,
          message_thread_id: 20,
          thread_id: "thread-1",
          objective: "Ship native goal sync",
          status: "paused",
          token_budget: 50_000,
          tokens_used: 12_000,
          time_used_seconds: 90,
          goal_created_at: 100,
          goal_updated_at: 200,
          observed_at: now,
          awaiting_edit: 0,
        }],
        recent: [{
          id: 1,
          chat_id: -10042,
          owner_user_id: 42,
          message_thread_id: 21,
          thread_id: "thread-2",
          topic_name: "Review",
          objective: "Finish review",
          tokens_used: 8_000,
          time_used_seconds: 60,
          goal_created_at: 300,
          completed_at: now,
          telegram_message_id: 99,
        }],
      },
    );

    expect(card).toContain("<p><b>goals</b></p>");
    expect(card).toContain("🎯 paused");
    expect(card).toContain("Ship native goal sync");
    expect(card).toContain("<details><summary>recent completed goals</summary>");
    expect(card).toContain("✓ Review");
  });
});

function pane(
  windowName: string,
  assistantName: "Sol" | "Terra" | "Lobby",
  busy: boolean,
) {
  return {
    serverPid: 1,
    paneId: `%${windowName.length}`,
    panePid: 100 + windowName.length,
    sessionName: "webterm",
    windowName,
    windowIndex: 0,
    cwd: "/root",
    active: true,
    busy,
    codexPid: 200 + windowName.length,
    assistantName,
  };
}
