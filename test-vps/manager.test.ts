import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatinaboxStore } from "../src/vps/store";
import {
  DEFAULT_EXPERIENCE_PROFILE,
  patchExperienceProfile,
} from "../src/vps/experience-profile";
import {
  formatManagerWelcome,
  ManagerController,
  managerThreadId,
} from "../src/vps/manager";

const roots: string[] = [];
const personalProfile = patchExperienceProfile(DEFAULT_EXPERIENCE_PROFILE, {
  setupComplete: true,
  manager: {
    name: "Mori",
    emoji: "🪄",
    role: "orchestrator",
    topicName: "🪄 Mori · orchestrator",
    topicIconEmoji: "🔮",
    cwd: "/var/lib/chatinabox-bridge/mori",
    model: "sol",
    reasoningEffort: "high",
    fast: false,
  },
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Manager topic", () => {
  it("requires and matches a dedicated forum topic", () => {
    expect(managerThreadId({})).toBe(0);
    expect(managerThreadId({ message_thread_id: 42 })).toBe(42);
    expect(formatManagerWelcome(personalProfile)).toContain(
      "<mark>🪄 Mori · awake</mark>",
    );
  });

  it("creates and persistently attaches a dedicated high-effort Sol worker", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chatinabox-wizard-"));
    roots.push(root);
    const store = new ChatinaboxStore(path.join(root, "state.sqlite"));
    const pane = {
      serverPid: 100,
      paneId: "%4",
      panePid: 200,
      sessionName: "codex",
      windowName: "🪄 Mori · orchestrator",
      windowIndex: 0,
      cwd: "/root",
      active: true,
      busy: false,
      codexPid: 300,
      assistantName: "Sol" as const,
      sessionId: "wizard-session",
    };
    const requests: unknown[] = [];
    const bridge = {
      request: vi.fn(async (request: unknown) => {
        requests.push(request);
        return requests.length === 1
          ? {
              ok: true,
              panes: [],
              recent: [],
              totalSessions: 0,
              usage: null,
            }
          : { ok: true, pane };
      }),
    };
    const sends: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("getForumTopicIconStickers")) {
        return {
          json: async () => ({
            ok: true,
            result: [{ emoji: "🔮", custom_emoji_id: "orb-id" }],
          }),
        };
      }
      sends.push(
        JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      );
      return {
        json: async () => ({
          ok: true,
          result: url.includes("editForumTopic")
            ? true
            : { message_id: 1_000 },
        }),
      };
    }));
    const controller = new ManagerController({
      env: {
        TG_BOT_TOKEN: "test-token",
        TG_ALLOWED_USER_IDS: "42",
        DATA_DIR: root,
        CODEX_BRIDGE_SOCKET: path.join(root, "bridge.sock"),
        DEFAULT_CWD: "/root",
      },
      store,
      bridge: bridge as never,
      profile: () => personalProfile,
    });
    await controller.handleCommand({
      message_id: 10,
      chat: { id: -10042, type: "supergroup" },
      message_thread_id: 2,
      is_topic_message: true,
      from: { id: 42 },
      text: "/wizard setup",
      date: 1,
    }, { name: "wizard", argument: "setup" });

    expect(requests[1]).toMatchObject({
      op: "new",
      name: "🪄 Mori · orchestrator",
      cwd: "/var/lib/chatinabox-bridge/mori",
      model: "sol",
      reasoningEffort: "high",
    });
    expect(store.managerTopic(-10042)).toMatchObject({
      message_thread_id: 2,
      pane_id: "%4",
    });
    expect(store.codexAttachment(-10042, 42, 2)?.pane_id).toBe("%4");
    const welcome = sends.find((body) => body.rich_message);
    expect(welcome?.reply_parameters).toMatchObject({ message_id: 10 });
    expect(controller.isManagerMessage({
      chat: { id: -10042 },
      message_thread_id: 2,
    })).toBe(true);
    expect(controller.isManagerMessage({
      chat: { id: -10042 },
      message_thread_id: 3,
    })).toBe(false);
    store.close();
  });
});
