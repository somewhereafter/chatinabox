import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EXPERIENCE_PROFILE,
  patchExperienceProfile,
} from "../src/vps/experience-profile";
import { ForumSetupController } from "../src/vps/forum-setup";
import { ChatinaboxStore } from "../src/vps/store";

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Forum bootstrap", () => {
  it("uses General for Overview and creates Manager exactly once", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chatinabox-forum-"));
    roots.push(root);
    const store = new ChatinaboxStore(path.join(root, "state.sqlite"));
    const profile = patchExperienceProfile(DEFAULT_EXPERIENCE_PROFILE, {
      setupComplete: true,
      overview: { name: "desk" },
      manager: { name: "guide", topicName: "🪄 guide" },
    });
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = url.split("/").pop() ?? "";
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ method, body });
      return {
        json: async () => ({
          ok: true,
          result: method === "createForumTopic"
            ? {
                message_thread_id: 68,
                name: "🪄 guide",
                icon_color: 1,
              }
            : { message_id: 900 },
        }),
      };
    }));
    const overview = {
      setupTopic: vi.fn(async (
        chatId: number,
        ownerUserId: number,
        messageThreadId: number,
      ) => {
        store.registerOverview(chatId, ownerUserId, messageThreadId);
        return true;
      }),
    };
    const manager = {
      setupTopic: vi.fn(async (
        chatId: number,
        ownerUserId: number,
        messageThreadId: number,
      ) => {
        store.registerManagerTopic(chatId, ownerUserId, messageThreadId);
        return true;
      }),
    };
    const controller = new ForumSetupController({
      env: {
        TG_BOT_TOKEN: "test-token",
        TG_ALLOWED_USER_IDS: "42",
        DATA_DIR: root,
        CODEX_BRIDGE_SOCKET: path.join(root, "bridge.sock"),
        DEFAULT_CWD: root,
      },
      store,
      overview,
      manager,
      profile: () => profile,
    });
    const message = {
      message_id: 10,
      chat: { id: -10042, type: "supergroup" as const },
      from: { id: 42 },
      text: "/forum setup",
      date: 1,
    };

    expect(await controller.handleCommand(
      message,
      { name: "forum", argument: "setup" },
    )).toBe(true);
    expect(store.overviewDashboard(-10042)?.message_thread_id).toBe(0);
    expect(store.managerTopic(-10042)?.message_thread_id).toBe(68);
    expect(calls.filter((call) => call.method === "createForumTopic"))
      .toHaveLength(1);
    expect(JSON.stringify(calls.at(-1)?.body)).toContain(
      "setup card will open automatically",
    );

    await controller.handleCommand(
      { ...message, message_id: 11 },
      { name: "forum", argument: "setup" },
    );
    expect(calls.filter((call) => call.method === "createForumTopic"))
      .toHaveLength(1);
    expect(manager.setupTopic).toHaveBeenLastCalledWith(-10042, 42, 68);
    store.close();
  });

  it("keeps bootstrap in General and waits for private setup", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chatinabox-forum-guard-"));
    roots.push(root);
    const store = new ChatinaboxStore(path.join(root, "state.sqlite"));
    const sends: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      sends.push(
        JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      );
      return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
    }));
    const overview = { setupTopic: vi.fn(async () => true) };
    const manager = { setupTopic: vi.fn(async () => true) };
    const controller = new ForumSetupController({
      env: {
        TG_BOT_TOKEN: "test-token",
        TG_ALLOWED_USER_IDS: "42",
        DATA_DIR: root,
        CODEX_BRIDGE_SOCKET: path.join(root, "bridge.sock"),
        DEFAULT_CWD: root,
      },
      store,
      overview,
      manager,
      profile: () => DEFAULT_EXPERIENCE_PROFILE,
    });

    await controller.handleCommand({
      message_id: 10,
      chat: { id: -10042, type: "supergroup" },
      message_thread_id: 7,
      from: { id: 42 },
      text: "/forum setup",
      date: 1,
    }, { name: "forum", argument: "setup" });
    expect(JSON.stringify(sends.at(-1))).toContain("in General");
    expect(overview.setupTopic).not.toHaveBeenCalled();

    await controller.handleCommand({
      message_id: 11,
      chat: { id: -10042, type: "supergroup" },
      from: { id: 42 },
      text: "/forum setup",
      date: 1,
    }, { name: "forum", argument: "setup" });
    expect(JSON.stringify(sends.at(-1))).toContain("private setup first");
    expect(overview.setupTopic).not.toHaveBeenCalled();
    store.close();
  });
});
