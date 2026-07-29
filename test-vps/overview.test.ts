import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  formatOverviewDashboard,
  OverviewController,
  overviewThreadId,
  overviewRenderSignature,
  overviewStatsFromBridge,
} from "../src/vps/overview";
import {
  DEFAULT_EXPERIENCE_PROFILE,
  patchExperienceProfile,
} from "../src/vps/experience-profile";
import { ChatinaboxStore } from "../src/vps/store";

const customProfile = patchExperienceProfile(DEFAULT_EXPERIENCE_PROFILE, {
  setupComplete: true,
  overview: { name: "desk", emoji: "◉" },
});

describe("Overview dashboard", () => {
  it("omits Telegram's thread field for a forum General topic", () => {
    expect(overviewThreadId({})).toBe(0);
    expect(overviewThreadId({ message_thread_id: 42 })).toBe(42);
  });

  it("promotes a manual topic without leaving work setup or an attachment", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chatinabox-overview-promote-"));
    const store = new ChatinaboxStore(path.join(root, "state.sqlite"));
    const worker = pane("temporary worker", "Sol", false);
    store.rememberTopic(-10042, 42, 7, "Overview", root);
    store.updateTopicSetup(-10042, 42, 7, { starter_message_id: 700 });
    store.attachCodex(-10042, 42, worker, 7);
    const calls: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push(
        JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      );
      return {
        json: async () => ({ ok: true, result: { message_id: 900 } }),
      };
    }));
    const controller = new OverviewController({
      env: {
        TG_BOT_TOKEN: "test-token",
        TG_ALLOWED_USER_IDS: "42",
        DATA_DIR: root,
        CODEX_BRIDGE_SOCKET: path.join(root, "bridge.sock"),
        DEFAULT_CWD: root,
      },
      store,
      bridge: {
        request: vi.fn(async () => ({
          ok: true as const,
          totalSessions: 0,
          recent: [],
          usage: null,
          panes: [],
        })),
      },
      profile: () => customProfile,
    });

    await controller.handleCommand({
      message_id: 10,
      chat: { id: -10042, type: "supergroup" },
      message_thread_id: 7,
      is_topic_message: true,
      from: { id: 42 },
      text: "/overview setup",
      date: 1,
    }, { name: "overview", argument: "setup" });

    expect(store.overviewDashboard(-10042)?.message_thread_id).toBe(7);
    expect(store.topicSetup(-10042, 42, 7)).toBeNull();
    expect(store.codexAttachment(-10042, 42, 7)).toBeNull();
    expect(JSON.stringify(calls)).toContain("reserved for Chatinabox control");
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("does not move an existing Overview when setup is sent elsewhere", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chatinabox-overview-guard-"));
    const store = new ChatinaboxStore(path.join(root, "state.sqlite"));
    store.registerOverview(-10042, 42, 0);
    const requests = vi.fn();
    const sends: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      sends.push(
        JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      );
      return {
        json: async () => ({ ok: true, result: { message_id: 900 } }),
      };
    }));
    const controller = new OverviewController({
      env: {
        TG_BOT_TOKEN: "test-token",
        TG_ALLOWED_USER_IDS: "42",
        DATA_DIR: root,
        CODEX_BRIDGE_SOCKET: path.join(root, "bridge.sock"),
        DEFAULT_CWD: root,
      },
      store,
      bridge: { request: requests },
      profile: () => customProfile,
    });

    await controller.handleCommand({
      message_id: 10,
      chat: { id: -10042, type: "supergroup" },
      message_thread_id: 7,
      is_topic_message: true,
      from: { id: 42 },
      text: "/overview setup",
      date: 1,
    }, { name: "overview", argument: "setup" });

    expect(store.overviewDashboard(-10042)?.message_thread_id).toBe(0);
    expect(requests).not.toHaveBeenCalled();
    expect(JSON.stringify(sends)).toContain("already set up");
    store.close();
    rmSync(root, { recursive: true, force: true });
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
    expect(card).toContain(
      "<blockquote><b>✓ complete</b> · Review<br/>",
    );
    expect(card).not.toContain("<p><b>✓ Review</b>");
  });

  it("batches schedules and their occurrence ledger into the dashboard", () => {
    const now = Date.parse("2026-07-29T10:00:00.000Z");
    const next = now + 60 * 60_000;
    const card = formatOverviewDashboard(
      {
        total: 1,
        active: 1,
        working: 1,
        idle: 0,
        bridgeOnline: true,
        usage: null,
      },
      now,
      customProfile,
      { current: [], recent: [] },
      {
        active: [{
          id: 7,
          chat_id: -10042,
          owner_user_id: 42,
          message_thread_id: 20,
          topic_name: "Build",
          kind: "task",
          name: "Morning build check",
          payload: "Inspect the build.",
          timing: "cron",
          timing_value: "0 9 * * 1-5",
          timezone: "Europe/London",
          enabled: 1,
          next_run_at: next,
          last_run_at: null,
          last_error: null,
          run_count: 0,
          consecutive_failures: 0,
          created_at: now,
          updated_at: now,
          cancelled_at: null,
        }],
        recent: [{
          id: 4,
          schedule_id: 7,
          scheduled_for: now - 60_000,
          manual: 0,
          status: "queued",
          attempt_count: 1,
          claimed_at: now - 60_000,
          completed_at: now - 59_000,
          telegram_message_id: null,
          error: null,
          created_at: now - 60_000,
          updated_at: now - 59_000,
          schedule_name: "Morning build check",
          schedule_kind: "task",
          topic_name: "Build",
        }],
      },
    );

    expect(card).toContain("<p><b>scheduled</b></p>");
    expect(card).toContain("⛅️ #7 Morning build check");
    expect(card).toContain("cron 0 9 * * 1-5 · Europe/London");
    expect(card).toContain("<details><summary>occurrence ledger</summary>");
    expect(card).toContain("✓ #7 Morning build check");
    expect(card).toContain("task · Build · queued");
  });

  it("deletes the old dashboard after creating a replacement", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chatinabox-overview-replace-"));
    let now = 1_800_000_000_000;
    const store = new ChatinaboxStore(
      path.join(root, "state.sqlite"),
      () => now,
    );
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = url.split("/").pop() ?? "";
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ method, body });
      if (method === "editMessageText") {
        return {
          json: async () => ({
            ok: false,
            error_code: 400,
            description: "message cannot be edited",
          }),
        };
      }
      if (method === "sendRichMessage") {
        return {
          json: async () => ({ ok: true, result: { message_id: 901 } }),
        };
      }
      return { json: async () => ({ ok: true, result: true }) };
    }));
    try {
      store.registerOverview(-10042, 42, 7);
      store.setOverviewDashboardMessage(-10042, 900, "old");
      const controller = new OverviewController({
        env: {
          TG_BOT_TOKEN: "test-token",
          TG_ALLOWED_USER_IDS: "42",
          DATA_DIR: root,
          CODEX_BRIDGE_SOCKET: path.join(root, "bridge.sock"),
          DEFAULT_CWD: root,
        },
        store,
        bridge: {
          request: vi.fn(async () => ({
            ok: true as const,
            totalSessions: 1,
            recent: [],
            usage: null,
            panes: [pane("Build", "Sol", true)],
          })),
        },
        now: () => now,
      });
      const refresh = (
        controller as unknown as {
          refreshDashboard(chatId: number, force: boolean): Promise<void>;
        }
      ).refreshDashboard.bind(controller);

      await refresh(-10042, true);

      expect(calls.map((call) => call.method)).toEqual([
        "editMessageText",
        "sendRichMessage",
        "deleteMessage",
      ]);
      expect(calls[2]?.body).toMatchObject({ message_id: 900 });
      expect(store.overviewDashboard(-10042)).toMatchObject({
        dashboard_message_id: 901,
        stale_message_id: null,
        stale_cleanup_at: 0,
      });
    } finally {
      vi.unstubAllGlobals();
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains a failed stale cleanup without creating another replacement", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chatinabox-overview-stale-"));
    let now = 1_800_000_000_000;
    const store = new ChatinaboxStore(
      path.join(root, "state.sqlite"),
      () => now,
    );
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = url.split("/").pop() ?? "";
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ method, body });
      if (method === "editMessageText") {
        return {
          json: async () => ({
            ok: false,
            error_code: 400,
            description: "message cannot be edited",
          }),
        };
      }
      if (method === "sendRichMessage") {
        return {
          json: async () => ({ ok: true, result: { message_id: 901 } }),
        };
      }
      return {
        json: async () => ({
          ok: false,
          error_code: 500,
          description: "temporary delete failure",
        }),
      };
    }));
    try {
      store.registerOverview(-10042, 42, 7);
      store.setOverviewDashboardMessage(-10042, 900, "old");
      const controller = new OverviewController({
        env: {
          TG_BOT_TOKEN: "test-token",
          TG_ALLOWED_USER_IDS: "42",
          DATA_DIR: root,
          CODEX_BRIDGE_SOCKET: path.join(root, "bridge.sock"),
          DEFAULT_CWD: root,
        },
        store,
        bridge: {
          request: vi.fn(async () => ({
            ok: true as const,
            totalSessions: 1,
            recent: [],
            usage: null,
            panes: [pane("Build", "Sol", true)],
          })),
        },
        now: () => now,
      });
      const refresh = (
        controller as unknown as {
          refreshDashboard(chatId: number, force: boolean): Promise<void>;
        }
      ).refreshDashboard.bind(controller);

      await refresh(-10042, true);
      expect(store.overviewDashboard(-10042)).toMatchObject({
        dashboard_message_id: 901,
        stale_message_id: 900,
        stale_cleanup_at: now,
      });

      calls.length = 0;
      now += 1_000;
      await refresh(-10042, true);
      expect(calls.filter((call) => call.method === "sendRichMessage"))
        .toHaveLength(0);
      expect(store.overviewDashboard(-10042)).toMatchObject({
        dashboard_message_id: 901,
        stale_message_id: 900,
      });
    } finally {
      vi.unstubAllGlobals();
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("caps automatic renders at thirty seconds and forces manual usage refresh", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chatinabox-overview-"));
    let now = 1_800_000_000_000;
    const store = new ChatinaboxStore(
      path.join(root, "state.sqlite"),
      () => now,
    );
    const bridge = {
      request: vi.fn(async () => ({
        ok: true as const,
        totalSessions: 2,
        recent: [],
        usage: null,
        panes: [pane("Build", "Sol", true)],
      })),
    };
    const fetchMock = vi.fn(async () => ({
      json: async () => ({ ok: true, result: true }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      store.registerOverview(-10042, 42, 7);
      store.setOverviewDashboardMessage(-10042, 900, "old");
      const controller = new OverviewController({
        env: {
          TG_BOT_TOKEN: "test-token",
          TG_ALLOWED_USER_IDS: "42",
          DATA_DIR: root,
          CODEX_BRIDGE_SOCKET: path.join(root, "bridge.sock"),
          DEFAULT_CWD: root,
        },
        store,
        bridge,
        now: () => now,
      });
      const refresh = (
        controller as unknown as {
          refreshDashboard(chatId: number, force: boolean): Promise<void>;
        }
      ).refreshDashboard.bind(controller);

      now += 10_000;
      await refresh(-10042, false);
      expect(fetchMock).not.toHaveBeenCalled();

      now += 20_000;
      await refresh(-10042, false);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      now += 1_000;
      await refresh(-10042, true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(bridge.request).toHaveBeenLastCalledWith({
        op: "list",
        refreshUsage: true,
      });
    } finally {
      vi.unstubAllGlobals();
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refreshes an unchanged synced timestamp only every two minutes", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chatinabox-overview-quiet-"));
    let now = 1_800_000_000_000;
    const store = new ChatinaboxStore(
      path.join(root, "state.sqlite"),
      () => now,
    );
    const response = {
      ok: true as const,
      totalSessions: 1,
      recent: [],
      usage: null,
      panes: [pane("Build", "Sol", true)],
    };
    const bridge = {
      request: vi.fn(async () => response),
    };
    const fetchMock = vi.fn(async () => ({
      json: async () => ({ ok: true, result: true }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      store.registerOverview(-10042, 42, 7);
      store.setOverviewDashboardMessage(
        -10042,
        900,
        overviewRenderSignature(overviewStatsFromBridge(response)),
      );
      const controller = new OverviewController({
        env: {
          TG_BOT_TOKEN: "test-token",
          TG_ALLOWED_USER_IDS: "42",
          DATA_DIR: root,
          CODEX_BRIDGE_SOCKET: path.join(root, "bridge.sock"),
          DEFAULT_CWD: root,
        },
        store,
        bridge,
        now: () => now,
      });
      const refresh = (
        controller as unknown as {
          refreshDashboard(chatId: number, force: boolean): Promise<void>;
        }
      ).refreshDashboard.bind(controller);

      now += 119_999;
      await refresh(-10042, false);
      expect(fetchMock).not.toHaveBeenCalled();

      now += 1;
      await refresh(-10042, false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
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
