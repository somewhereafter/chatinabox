import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatinaboxStore } from "../src/vps/store";
import {
  formatSetupCard,
  normalizeTopicName,
  normalizeWorkspace,
  TopicSessionController,
} from "../src/vps/topic-sessions";
import {
  DEFAULT_EXPERIENCE_PROFILE,
  patchExperienceProfile,
  type ExperienceProfile,
} from "../src/vps/experience-profile";

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function setup(profile?: ExperienceProfile) {
  const root = mkdtempSync(path.join(os.tmpdir(), "chatinabox-topic-"));
  roots.push(root);
  const store = new ChatinaboxStore(path.join(root, "state.sqlite"));
  const pane = {
    serverPid: 100,
    paneId: "%4",
    panePid: 200,
    sessionName: "codex",
    windowName: "🧪 experiment",
    windowIndex: 0,
    cwd: "/root",
    active: true,
    busy: false,
    codexPid: 300,
    assistantName: "Sol" as const,
    sessionId: "topic-session",
  };
  const requests: unknown[] = [];
  const bridge = {
    request: vi.fn(async (request: unknown) => {
      requests.push(request);
      return { ok: true, pane };
    }),
  };
  const sends: Array<Record<string, unknown>> = [];
  let nextMessageId = 100;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    sends.push(
      JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    );
    return {
      json: async () => ({
        ok: true,
        result: { message_id: nextMessageId++ },
      }),
    };
  }));
  const controller = new TopicSessionController({
    env: {
      TG_BOT_TOKEN: "test-token",
      TG_ALLOWED_USER_IDS: "42",
      DATA_DIR: root,
      CODEX_BRIDGE_SOCKET: path.join(root, "bridge.sock"),
      DEFAULT_CWD: "/root",
    },
    store,
    bridge: bridge as never,
    ...(profile ? { profile: () => profile } : {}),
  });
  return { controller, store, pane, requests, sends };
}

describe("Topic session setup", () => {
  it("normalizes names and absolute workspaces", () => {
    expect(normalizeTopicName("  🧪   experiment  ")).toBe("🧪 experiment");
    expect(normalizeTopicName("")).toBeNull();
    expect(normalizeWorkspace("/root/project/../app")).toBe("/root/app");
    expect(normalizeWorkspace("relative/project")).toBeNull();
  });

  it("inherits a new forum topic name and launches its configured chat", async () => {
    const { controller, store, requests, sends } = setup();
    const topic = {
      message_id: 10,
      chat: { id: -10042, type: "supergroup" as const },
      message_thread_id: 7,
      is_topic_message: true,
      from: { id: 42 },
      forum_topic_created: {
        name: "🧪 experiment",
        icon_color: 1,
      },
      date: 1,
    };
    await controller.handleMessage(topic, null);
    expect(store.topicSetup(-10042, 42, 7)?.topic_name)
      .toBe("🧪 experiment");

    await controller.handleMessage({
      ...topic,
      message_id: 11,
      text: "/setup",
      forum_topic_created: undefined,
    }, { name: "setup", argument: "" });
    const card = sends.find((body) => body.rich_message) as
      | Record<string, unknown>
      | undefined;
    expect(card?.message_thread_id).toBe(7);
    expect(JSON.stringify(card)).toContain("🧪 experiment");
    const keyboard = card?.reply_markup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    };
    const startCallback =
      keyboard.inline_keyboard.at(-1)?.[0]?.callback_data;
    expect(startCallback).toBeTruthy();

    await controller.handleCallback({
      id: "callback",
      from: { id: 42 },
      message: {
        message_id: 100,
        message_thread_id: 7,
        chat: { id: -10042, type: "supergroup" },
      },
      data: startCallback,
    });
    expect(requests).toContainEqual({
      op: "new",
      name: "🧪 experiment",
      cwd: "/root",
      model: "sol",
      reasoningEffort: "high",
      fast: false,
    });
    expect(store.codexAttachment(-10042, 42, 7)?.pane_id).toBe("%4");
    store.close();
  });

  it("inherits launch defaults from the private profile", async () => {
    const profile = patchExperienceProfile(DEFAULT_EXPERIENCE_PROFILE, {
      sessions: {
        defaultModel: "terra",
        defaultReasoningEffort: "low",
        defaultFast: true,
      },
    });
    const { controller, store } = setup(profile);
    await controller.handleMessage({
      message_id: 10,
      chat: { id: -10042, type: "supergroup" },
      message_thread_id: 7,
      is_topic_message: true,
      from: { id: 42 },
      forum_topic_created: { name: "quiet work", icon_color: 1 },
      date: 1,
    }, null);
    expect(store.topicSetup(-10042, 42, 7)).toMatchObject({
      model: "terra",
      reasoning_effort: "low",
      fast: 1,
    });
    store.close();
  });

  it("renames the live session when its bound Telegram topic changes", async () => {
    const { controller, store, pane, requests } = setup();
    store.attachCodex(-10042, 42, pane, 7);
    await controller.handleMessage({
      message_id: 12,
      chat: { id: -10042, type: "supergroup" },
      message_thread_id: 7,
      is_topic_message: true,
      from: { id: 42 },
      forum_topic_edited: { name: "🌱 garden" },
      date: 1,
    }, null);
    expect(requests).toContainEqual({
      op: "rename",
      target: { serverPid: 100, paneId: "%4", panePid: 200 },
      name: "🌱 garden",
    });
    expect(store.topicSetup(-10042, 42, 7)?.topic_name).toBe("🌱 garden");
    expect(formatSetupCard(store.topicSetup(-10042, 42, 7)!))
      .toContain("🌱 garden");
    store.close();
  });

  it("uses topic icons for working/done transitions without redundant edits", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chatinabox-presence-"));
    roots.push(root);
    const store = new ChatinaboxStore(path.join(root, "state.sqlite"));
    let busy = true;
    let now = 1_000;
    const pane = {
      serverPid: 100,
      paneId: "%4",
      panePid: 200,
      sessionName: "codex",
      windowName: "🧪 experiment",
      windowIndex: 0,
      cwd: "/root",
      active: true,
      busy,
      codexPid: 300,
      assistantName: "Sol" as const,
    };
    store.attachCodex(-10042, 42, pane, 7);
    const bridge = {
      request: vi.fn(async () => ({
        ok: true,
        panes: [{ ...pane, busy }],
        recent: [],
        totalSessions: 1,
        usage: null,
      })),
    };
    const iconEdits: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("getForumTopicIconStickers")) {
        return {
          json: async () => ({
            ok: true,
            result: [
              { emoji: "🧪", custom_emoji_id: "working-id" },
              { emoji: "✅", custom_emoji_id: "done-id" },
              { emoji: "📁", custom_emoji_id: "closed-id" },
            ],
          }),
        };
      }
      iconEdits.push(
        JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      );
      return { json: async () => ({ ok: true, result: true }) };
    }));
    const controller = new TopicSessionController({
      env: {
        TG_BOT_TOKEN: "test-token",
        TG_ALLOWED_USER_IDS: "42",
        DATA_DIR: root,
        CODEX_BRIDGE_SOCKET: path.join(root, "bridge.sock"),
        DEFAULT_CWD: "/root",
      },
      store,
      bridge: bridge as never,
      now: () => now,
    });

    await controller.refreshPresence();
    await controller.refreshPresence();
    expect(iconEdits).toHaveLength(1);
    expect(iconEdits[0]).toMatchObject({
      message_thread_id: 7,
      icon_custom_emoji_id: "working-id",
    });
    expect(store.topicSetup(-10042, 42, 7)?.last_icon_status)
      .toBe("working");

    busy = false;
    await controller.refreshPresence();
    expect(iconEdits).toHaveLength(1);
    expect(store.topicSetup(-10042, 42, 7)?.last_icon_status)
      .toBe("working");

    now += 30_000;
    await controller.refreshPresence();
    expect(iconEdits).toHaveLength(2);
    expect(iconEdits[1]?.icon_custom_emoji_id).toBe("done-id");
    expect(store.topicSetup(-10042, 42, 7)?.last_icon_status).toBe("done");
    store.close();
  });

  it("closes continuously idle workers and resumes them from the topic card", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chatinabox-sleep-"));
    roots.push(root);
    const store = new ChatinaboxStore(path.join(root, "state.sqlite"));
    let now = 1_000;
    const pane = {
      serverPid: 100,
      paneId: "%4",
      panePid: 200,
      sessionName: "codex",
      windowName: "🧪 experiment",
      windowIndex: 0,
      cwd: "/root/project",
      active: true,
      busy: false,
      codexPid: 300,
      assistantName: "Sol" as const,
      sessionId: "019f9ce4-aceb-75e1-bf3a-84e1495098fb",
    };
    const resumed = {
      ...pane,
      paneId: "%5",
      panePid: 201,
      codexPid: 301,
    };
    store.attachCodex(-10042, 42, pane, 7);
    const requests: Array<Record<string, unknown>> = [];
    const bridge = {
      request: vi.fn(async (request: Record<string, unknown>) => {
        requests.push(request);
        if (request.op === "list") {
          return {
            ok: true,
            panes: store.codexAttachment(-10042, 42, 7) ? [pane] : [],
            recent: [],
            totalSessions: 1,
            usage: null,
          };
        }
        if (request.op === "close") {
          return {
            ok: true,
            closed: true,
            sessionId: pane.sessionId,
            profile: {
              model: "sol",
              reasoningEffort: "high",
              fast: false,
              cwd: pane.cwd,
            },
          };
        }
        if (request.op === "resume") return { ok: true, pane: resumed };
        throw new Error(`Unexpected request: ${String(request.op)}`);
      }),
    };
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    let nextMessageId = 500;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(
        String(init?.body ?? "{}"),
      ) as Record<string, unknown>;
      calls.push({ url, body });
      if (url.includes("getForumTopicIconStickers")) {
        return {
          json: async () => ({
            ok: true,
            result: [
              { emoji: "🧪", custom_emoji_id: "working-id" },
              { emoji: "✅", custom_emoji_id: "done-id" },
              { emoji: "📁", custom_emoji_id: "closed-id" },
            ],
          }),
        };
      }
      return {
        json: async () => ({
          ok: true,
          result: url.includes("sendRichMessage")
            ? { message_id: nextMessageId++ }
            : true,
        }),
      };
    }));
    const controller = new TopicSessionController({
      env: {
        TG_BOT_TOKEN: "test-token",
        TG_ALLOWED_USER_IDS: "42",
        DATA_DIR: root,
        CODEX_BRIDGE_SOCKET: path.join(root, "bridge.sock"),
        DEFAULT_CWD: "/root",
      },
      store,
      bridge: bridge as never,
      now: () => now,
    });

    await controller.refreshPresence();
    expect(store.topicSetup(-10042, 42, 7)?.idle_since).toBe(1_000);
    now += 30 * 60 * 1_000;
    await controller.refreshPresence();
    expect(store.codexAttachment(-10042, 42, 7)).toBeNull();
    expect(store.topicSetup(-10042, 42, 7)).toMatchObject({
      closed_session_id: pane.sessionId,
      last_icon_status: "closed",
    });
    const resting = calls.find((call) =>
      call.url.includes("sendRichMessage")
    )?.body;
    const restartCallback = (
      resting?.reply_markup as {
        inline_keyboard: Array<Array<{ callback_data: string }>>;
      }
    ).inline_keyboard[0]?.[0]?.callback_data;
    expect(restartCallback).toBeTruthy();

    await controller.handleCallback({
      id: "restart",
      from: { id: 42 },
      message: {
        message_id: 500,
        message_thread_id: 7,
        chat: { id: -10042, type: "supergroup" },
      },
      data: restartCallback,
    });
    expect(requests).toContainEqual({
      op: "resume",
      sessionId: pane.sessionId,
      name: "🧪 experiment",
      cwd: "/root/project",
      model: "sol",
      reasoningEffort: "high",
      fast: false,
    });
    expect(store.codexAttachment(-10042, 42, 7)?.pane_id).toBe("%5");
    expect(store.topicSetup(-10042, 42, 7)).toMatchObject({
      closed_session_id: null,
      closed_at: null,
      last_icon_status: "done",
    });
    store.close();
  });
});
