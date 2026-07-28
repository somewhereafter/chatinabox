import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatinaboxStore } from "../src/vps/store";
import {
  formatSetupCard,
  isReservedLobbySetup,
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

function setup(
  profile?: ExperienceProfile,
  bridgeHandler?: (request: unknown) => Promise<Record<string, unknown>>,
) {
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
      if (bridgeHandler) return bridgeHandler(request);
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
    readyBufferMs: 0,
    ...(profile ? { profile: () => profile } : {}),
  });
  return { controller, store, pane, requests, sends };
}

function callbackByLabel(
  sends: readonly Record<string, unknown>[],
  label: string,
): string | undefined {
  for (const body of [...sends].reverse()) {
    const keyboard = body.reply_markup as
      | { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> }
      | undefined;
    const callback = keyboard?.inline_keyboard
      ?.flat()
      .find((button) => button.text.includes(label))
      ?.callback_data;
    if (callback) return callback;
  }
  return undefined;
}

describe("Topic session setup", () => {
  it("normalizes names and absolute workspaces", () => {
    expect(normalizeTopicName("  🧪   experiment  ")).toBe("🧪 experiment");
    expect(normalizeTopicName("")).toBeNull();
    expect(normalizeWorkspace("/root/project/../app")).toBe("/root/app");
    expect(normalizeWorkspace("relative/project")).toBeNull();
    expect(isReservedLobbySetup({
      topic_name: "🪄 Lobby",
      cwd: "/root",
    })).toBe(true);
    expect(isReservedLobbySetup({
      topic_name: "review",
      cwd: "/var/lib/chatinabox-bridge/lobby",
    })).toBe(true);
    expect(isReservedLobbySetup({
      topic_name: "review",
      cwd: "/root/chatinabox",
    })).toBe(false);
  });

  it("blocks work setup and stale setup buttons in control topics", async () => {
    const { controller, store, requests, sends } = setup();
    const topic = {
      message_id: 10,
      chat: { id: -10042, type: "supergroup" as const },
      message_thread_id: 7,
      is_topic_message: true,
      from: { id: 42 },
      forum_topic_created: { name: "overview", icon_color: 1 },
      date: 1,
    };
    await controller.handleMessage(topic, null);
    const startCallback = callbackByLabel(sends, "new chat");
    expect(startCallback).toBeTruthy();
    store.registerOverview(-10042, 42, 7);

    expect(await controller.handleMessage({
      ...topic,
      message_id: 11,
      text: "/setup",
      forum_topic_created: undefined,
    }, { name: "setup", argument: "" })).toBe(true);
    expect(JSON.stringify(sends.at(-1))).toContain("control topic");

    expect(await controller.handleCallback({
      id: "stale-control-card",
      from: { id: 42 },
      message: {
        message_id: 100,
        message_thread_id: 7,
        chat: { id: -10042, type: "supergroup" },
      },
      data: startCallback,
    })).toBe(true);
    expect(JSON.stringify(sends)).toContain("show_alert");
    expect(requests.some((request) =>
      (request as { op?: string }).op === "new"
    )).toBe(false);
    store.close();
  });

  it("never lets a temporarily attached Lobby overwrite topic setup", async () => {
    const { controller, store } = setup();
    store.rememberTopic(
      -10042,
      42,
      7,
      "review",
      "/root/chatinabox",
      { model: "sol", reasoningEffort: "high", fast: false },
    );
    store.attachCodex(-10042, 42, {
      serverPid: 100,
      paneId: "%17",
      panePid: 217,
      sessionName: "codex",
      windowName: "🪄 Lobby",
      windowIndex: 0,
      cwd: "/var/lib/chatinabox-bridge/lobby",
      active: true,
      busy: false,
      codexPid: 317,
      assistantName: "Lobby",
      sessionId: "lobby-session",
    }, 7);

    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
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
      return { json: async () => ({ ok: true, result: true }) };
    }));

    await controller.refreshPresence();
    expect(store.topicSetup(-10042, 42, 7)).toMatchObject({
      topic_name: "review",
      cwd: "/root/chatinabox",
    });
    store.close();
  });

  it("repairs stale Lobby defaults instead of launching a duplicate", async () => {
    const { controller, store, requests, sends } = setup();
    const topic = {
      message_id: 10,
      chat: { id: -10042, type: "supergroup" as const },
      message_thread_id: 7,
      is_topic_message: true,
      from: { id: 42 },
      forum_topic_created: { name: "review", icon_color: 1 },
      date: 1,
    };
    await controller.handleMessage(topic, null);
    await controller.handleMessage({
      ...topic,
      message_id: 11,
      text: "/setup",
      forum_topic_created: undefined,
    }, { name: "setup", argument: "" });
    const startCallback = callbackByLabel(sends, "new chat");
    expect(startCallback).toBeTruthy();
    store.updateTopicSetup(-10042, 42, 7, {
      topic_name: "🪄 Lobby",
      cwd: "/var/lib/chatinabox-bridge/lobby",
    });

    await controller.handleCallback({
      id: "start-polluted",
      from: { id: 42 },
      message: {
        message_id: 100,
        message_thread_id: 7,
        chat: { id: -10042, type: "supergroup" },
      },
      data: startCallback,
    });

    expect(requests.some((request) =>
      (request as { op?: string }).op === "new"
    )).toBe(false);
    expect(store.topicSetup(-10042, 42, 7)).toMatchObject({
      topic_name: "new codex chat",
      cwd: "/root",
    });
    expect(JSON.stringify(sends.at(-1))).toContain("Lobby is reserved");
    store.close();
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
    expect(JSON.stringify(card)).toContain("ask orchestrator");
    expect(JSON.stringify(card)).not.toContain("private manager name");
    const keyboard = card?.reply_markup as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
    const startCallback = keyboard.inline_keyboard
      .flat()
      .find((button) => button.text.includes("new chat"))
      ?.callback_data;
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

  it("chooses a detected repository from the new-topic setup", async () => {
    const { controller, store, sends, requests } = setup(
      undefined,
      async (request) => {
        if ((request as { op?: string }).op === "workspaces") {
          return {
            ok: true,
            workspaces: [{ name: "chatinabox", path: "/root/chatinabox" }],
          };
        }
        return { ok: false, error: "unexpected request" };
      },
    );
    await controller.handleMessage({
      message_id: 10,
      chat: { id: -10042, type: "supergroup" },
      message_thread_id: 7,
      is_topic_message: true,
      from: { id: 42 },
      forum_topic_created: { name: "new work", icon_color: 1 },
      date: 1,
    }, null);
    const repositories = callbackByLabel(sends, "choose repo");
    expect(repositories).toBeTruthy();
    await controller.handleCallback({
      id: "repositories",
      from: { id: 42 },
      message: {
        message_id: 100,
        message_thread_id: 7,
        chat: { id: -10042, type: "supergroup" },
      },
      data: repositories,
    });
    expect(requests).toContainEqual({ op: "workspaces" });
    const repository = callbackByLabel(sends, "chatinabox");
    expect(repository).toBeTruthy();
    await controller.handleCallback({
      id: "repository",
      from: { id: 42 },
      message: {
        message_id: 100,
        message_thread_id: 7,
        chat: { id: -10042, type: "supergroup" },
      },
      data: repository,
    });
    expect(store.topicSetup(-10042, 42, 7)?.cwd).toBe("/root/chatinabox");
    store.close();
  });

  it("starts a temporary natural-language manager guide in a new topic", async () => {
    const profile = patchExperienceProfile(DEFAULT_EXPERIENCE_PROFILE, {
      manager: {
        name: "Guide",
        emoji: "🪄",
        cwd: "/var/lib/chatinabox-bridge/manager",
        model: "terra",
        reasoningEffort: "high",
        fast: true,
      },
    });
    const { controller, store, sends, requests, pane } = setup(
      profile,
      async () => ({
        ok: true,
        pane: {
          ...pane,
          windowName: "Guide · setup · new work",
          cwd: "/var/lib/chatinabox-bridge/manager",
          assistantName: "Terra",
        },
      }),
    );
    await controller.handleMessage({
      message_id: 10,
      chat: { id: -10042, type: "supergroup" },
      message_thread_id: 7,
      is_topic_message: true,
      from: { id: 42 },
      forum_topic_created: { name: "new work", icon_color: 1 },
      date: 1,
    }, null);
    const askManager = callbackByLabel(sends, "ask Guide");
    expect(askManager).toBeTruthy();
    await controller.handleCallback({
      id: "manager",
      from: { id: 42 },
      message: {
        message_id: 100,
        message_thread_id: 7,
        chat: { id: -10042, type: "supergroup" },
      },
      data: askManager,
    });
    expect(requests).toContainEqual({
      op: "new",
      name: "Guide · setup · new work",
      cwd: "/var/lib/chatinabox-bridge/manager",
      model: "terra",
      reasoningEffort: "high",
      fast: true,
    });
    expect(store.codexAttachment(-10042, 42, 7)?.window_name)
      .toBe("Guide · setup · new work");
    expect(JSON.stringify(sends.at(-1))).toContain("setup guide");
    store.close();
  });

  it("connects an unbound running Codex session from topic setup", async () => {
    const unboundPane = {
      serverPid: 101,
      paneId: "%9",
      panePid: 201,
      sessionName: "codex",
      windowName: "existing investigation",
      windowIndex: 2,
      cwd: "/root/investigation",
      active: true,
      busy: true,
      codexPid: 301,
      assistantName: "Sol" as const,
      sessionId: "019d1234-1234-7123-8123-123456789abc",
    };
    const { controller, store, sends } = setup(
      undefined,
      async (request) =>
        (request as { op?: string }).op === "list"
          ? {
              ok: true,
              panes: [unboundPane],
              recent: [],
              totalSessions: 1,
              usage: null,
            }
          : { ok: false, error: "unexpected request" },
    );
    await controller.handleMessage({
      message_id: 10,
      chat: { id: -10042, type: "supergroup" },
      message_thread_id: 7,
      is_topic_message: true,
      from: { id: 42 },
      forum_topic_created: { name: "new work", icon_color: 1 },
      date: 1,
    }, null);
    await controller.handleCallback({
      id: "sessions",
      from: { id: 42 },
      message: {
        message_id: 100,
        message_thread_id: 7,
        chat: { id: -10042, type: "supergroup" },
      },
      data: callbackByLabel(sends, "existing Codex"),
    });
    const existing = callbackByLabel(sends, "existing investigation");
    expect(existing).toBeTruthy();
    await controller.handleCallback({
      id: "attach",
      from: { id: 42 },
      message: {
        message_id: 100,
        message_thread_id: 7,
        chat: { id: -10042, type: "supergroup" },
      },
      data: existing,
    });
    expect(store.codexAttachment(-10042, 42, 7)?.pane_id).toBe("%9");
    store.close();
  });

  it("resumes an unrepresented saved Codex chat from topic setup", async () => {
    const sessionId = "019d1234-1234-7123-8123-123456789abc";
    const resumedPane = {
      serverPid: 101,
      paneId: "%9",
      panePid: 201,
      sessionName: "codex",
      windowName: "saved investigation",
      windowIndex: 2,
      cwd: "/root",
      active: true,
      busy: false,
      codexPid: 301,
      assistantName: "Terra" as const,
      sessionId,
    };
    const { controller, store, sends, requests } = setup(
      undefined,
      async (request) => {
        if ((request as { op?: string }).op === "list") {
          return {
            ok: true,
            panes: [],
            recent: [{
              id: sessionId,
              name: "saved investigation",
              updatedAt: "2026-07-27T09:00:00.000Z",
            }],
            totalSessions: 1,
            usage: null,
          };
        }
        if ((request as { op?: string }).op === "resume") {
          return { ok: true, pane: resumedPane };
        }
        return { ok: false, error: "unexpected request" };
      },
    );
    await controller.handleMessage({
      message_id: 10,
      chat: { id: -10042, type: "supergroup" },
      message_thread_id: 7,
      is_topic_message: true,
      from: { id: 42 },
      forum_topic_created: { name: "new work", icon_color: 1 },
      date: 1,
    }, null);
    await controller.handleCallback({
      id: "sessions",
      from: { id: 42 },
      message: {
        message_id: 100,
        message_thread_id: 7,
        chat: { id: -10042, type: "supergroup" },
      },
      data: callbackByLabel(sends, "existing Codex"),
    });
    const saved = callbackByLabel(sends, "saved investigation");
    expect(saved).toBeTruthy();
    await controller.handleCallback({
      id: "resume",
      from: { id: 42 },
      message: {
        message_id: 100,
        message_thread_id: 7,
        chat: { id: -10042, type: "supergroup" },
      },
      data: saved,
    });
    expect(requests).toContainEqual({
      op: "resume",
      sessionId,
      name: "saved investigation",
      cwd: "/root",
      model: "sol",
      reasoningEffort: "high",
      fast: false,
    });
    expect(store.codexAttachment(-10042, 42, 7)?.window_name)
      .toBe("saved investigation");
    store.close();
  });

  it("resumes a resting topic from its next message before routing it", async () => {
    const { controller, store, pane, requests, sends } = setup();
    const sessionId = "019f9ce4-aceb-75e1-bf3a-84e1495098fb";
    store.rememberTopic(
      -10042,
      42,
      7,
      "🧪 experiment",
      "/root/project",
    );
    store.updateTopicSetup(-10042, 42, 7, {
      closed_session_id: sessionId,
      closed_at: 1_000,
    });

    const consumed = await controller.handleMessage({
      message_id: 77,
      chat: { id: -10042, type: "supergroup" },
      message_thread_id: 7,
      is_topic_message: true,
      from: { id: 42 },
      text: "Continue from the last checkpoint.",
      date: 1,
    }, null);

    expect(consumed).toBe(false);
    expect(requests[0]).toEqual({
      op: "resume",
      sessionId,
      name: "🧪 experiment",
      cwd: "/root/project",
      model: "sol",
      reasoningEffort: "high",
      fast: false,
    });
    expect(store.codexAttachment(-10042, 42, 7)?.pane_id).toBe(pane.paneId);
    expect(store.topicSetup(-10042, 42, 7)).toMatchObject({
      closed_session_id: null,
      closed_at: null,
    });
    expect(JSON.stringify(sends[0])).toContain("Resuming 🧪 experiment");
    expect(JSON.stringify(sends.at(-1))).toContain("Sending your message now");
    store.close();
  });

  it("restarts a polluted Review topic as a fresh worker outside Lobby", async () => {
    const { controller, store, requests } = setup();
    store.rememberTopic(
      -10042,
      42,
      7,
      "Review",
      "/var/lib/chatinabox-bridge/lobby",
    );
    store.updateTopicSetup(-10042, 42, 7, {
      closed_session_id: "019fa305-565d-7190-a1fc-d8a613e43f33",
      closed_at: 1_000,
    });

    const consumed = await controller.handleMessage({
      message_id: 79,
      chat: { id: -10042, type: "supergroup" },
      message_thread_id: 7,
      is_topic_message: true,
      from: { id: 42 },
      text: "Start a separate task.",
      date: 1,
    }, null);

    expect(consumed).toBe(false);
    expect(requests).toEqual([{
      op: "new",
      name: "Review",
      cwd: "/root",
      model: "sol",
      reasoningEffort: "high",
      fast: false,
    }]);
    expect(store.topicSetup(-10042, 42, 7)).toMatchObject({
      topic_name: "Review",
      cwd: "/root",
      closed_session_id: null,
      closed_at: null,
    });
    store.close();
  });

  it("never replaces a failed saved-session resume with a blank chat", async () => {
    const { controller, store, requests, sends } = setup(
      undefined,
      async () => ({
        ok: false,
        code: "START_FAILED",
        error: "Codex session did not become ready.",
      }),
    );
    const sessionId = "019f9ce4-aceb-75e1-bf3a-84e1495098fb";
    store.rememberTopic(-10042, 42, 7, "sleeping chat", "/root");
    store.updateTopicSetup(-10042, 42, 7, {
      closed_session_id: sessionId,
      closed_at: 1_000,
    });

    const consumed = await controller.handleMessage({
      message_id: 78,
      chat: { id: -10042, type: "supergroup" },
      message_thread_id: 7,
      is_topic_message: true,
      from: { id: 42 },
      text: "Are you there?",
      date: 1,
    }, null);

    expect(consumed).toBe(true);
    expect(requests.map((request) => (
      request as { op?: string }
    ).op)).toEqual(["resume"]);
    expect(store.codexAttachment(-10042, 42, 7)).toBeNull();
    expect(store.topicSetup(-10042, 42, 7)).toMatchObject({
      closed_session_id: sessionId,
      closed_at: 1_000,
    });
    expect(JSON.stringify(sends.at(-1))).toContain("Your message was not sent");
    expect(JSON.stringify(sends.at(-1))).toContain(
      "saved chat was not replaced",
    );
    expect(JSON.stringify(sends.at(-1))).toContain("restart session");
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

  it("clears a stale transient when the worker is already idle", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chatinabox-stale-presence-"));
    roots.push(root);
    let now = 1_000;
    const store = new ChatinaboxStore(
      path.join(root, "state.sqlite"),
      () => now,
    );
    const pane = {
      serverPid: 100,
      paneId: "%4",
      panePid: 200,
      sessionName: "codex",
      windowName: "review",
      windowIndex: 0,
      cwd: "/root",
      active: true,
      busy: false,
      codexPid: 300,
      assistantName: "Sol" as const,
    };
    store.attachCodex(-10042, 42, pane, 7);
    store.setCodexStatus(-10042, 42, pane, 700, {
      statusKind: "state_working",
      toolCalls: 0,
      editedFiles: 0,
      exploredThings: 0,
      activeShells: 0,
      queuedMessages: 0,
      replyToMessageId: 650,
      startedAt: now,
    });
    const calls: Array<{
      method: string;
      body: Record<string, unknown>;
    }> = [];
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
      calls.push({
        method: url.split("/").pop() ?? "",
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
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
      bridge: {
        request: vi.fn(async () => ({
          ok: true,
          panes: [pane],
          recent: [],
          totalSessions: 1,
          usage: null,
        })),
      } as never,
      now: () => now,
    });

    now += 30_000;
    await controller.refreshPresence();

    expect(store.codexStatus(-10042, 42, pane)).toBeNull();
    expect(calls).toContainEqual({
      method: "deleteMessage",
      body: { chat_id: -10042, message_id: 700 },
    });
    expect(calls).toContainEqual({
      method: "editForumTopic",
      body: {
        chat_id: -10042,
        message_thread_id: 7,
        icon_custom_emoji_id: "done-id",
      },
    });
    expect(store.topicSetup(-10042, 42, 7)?.last_icon_status).toBe("done");
    store.close();
  });

  it("leaves the persistent manager topic icon outside worker presence states", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chatinabox-manager-presence-"));
    roots.push(root);
    let now = 1_000;
    const store = new ChatinaboxStore(
      path.join(root, "state.sqlite"),
      () => now,
    );
    const pane = {
      serverPid: 100,
      paneId: "%4",
      panePid: 200,
      sessionName: "codex",
      windowName: "🪄 Guide · orchestrator",
      windowIndex: 0,
      cwd: "/var/lib/chatinabox-bridge/manager",
      active: true,
      busy: false,
      codexPid: 300,
      assistantName: "Sol" as const,
    };
    store.registerManagerTopic(-10042, 42, 7);
    store.setManagerTarget(-10042, pane);
    store.attachCodex(-10042, 42, pane, 7);
    const requests: Array<Record<string, unknown>> = [];
    const bridge = {
      request: vi.fn(async (request: Record<string, unknown>) => {
        requests.push(request);
        return {
          ok: true,
          panes: [pane],
          recent: [],
          totalSessions: 1,
          usage: null,
        };
      }),
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
    expect(iconEdits).toHaveLength(0);
    expect(store.topicSetup(-10042, 42, 7)).toBeNull();

    now += 31 * 60 * 1_000;
    await controller.refreshPresence();
    expect(requests.some((request) => request.op === "close")).toBe(false);
    expect(store.codexAttachment(-10042, 42, 7)).not.toBeNull();
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
