import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  issueCallbackReference,
  parseCallbackReference,
} from "../src/telegram-callback";
import { ChatinaboxStore } from "../src/vps/store";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "chatinabox-store-"));
  roots.push(root);
  return root;
}

describe("ChatinaboxStore", () => {
  it("migrates legacy chat-scoped attachments and status without data loss", async () => {
    const root = await temporaryRoot();
    const databasePath = path.join(root, "legacy.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE codex_attachments (
        chat_id INTEGER NOT NULL,
        owner_user_id INTEGER NOT NULL,
        server_pid INTEGER NOT NULL,
        pane_id TEXT NOT NULL,
        pane_pid INTEGER NOT NULL,
        session_name TEXT NOT NULL,
        window_name TEXT NOT NULL,
        assistant_name TEXT NOT NULL DEFAULT 'Codex',
        cwd TEXT NOT NULL,
        attached_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, owner_user_id)
      );
      INSERT INTO codex_attachments VALUES (
        42, 42, 100, '%4', 200, 'codex', 'legacy', 'Sol', '/root', 123
      );
      CREATE TABLE codex_status_messages (
        chat_id INTEGER NOT NULL,
        owner_user_id INTEGER NOT NULL,
        server_pid INTEGER NOT NULL,
        pane_id TEXT NOT NULL,
        pane_pid INTEGER NOT NULL,
        telegram_message_id INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        status_kind TEXT NOT NULL DEFAULT 'state_working',
        tool_calls INTEGER NOT NULL DEFAULT 0,
        edited_files INTEGER NOT NULL DEFAULT 0,
        explored_things INTEGER NOT NULL DEFAULT 0,
        active_shells INTEGER NOT NULL DEFAULT 0,
        queued_messages INTEGER NOT NULL DEFAULT 0,
        reply_to_message_id INTEGER,
        started_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (chat_id, owner_user_id)
      );
      INSERT INTO codex_status_messages VALUES (
        42, 42, 100, '%4', 200, 88, 2000, 'state_activity',
        3, 1, 2, 0, 0, 77, 1000
      );
    `);
    legacy.close();

    const store = new ChatinaboxStore(databasePath);
    const target = { serverPid: 100, paneId: "%4", panePid: 200 };
    expect(store.codexAttachment(42, 42, 0)).toMatchObject({
      message_thread_id: 0,
      pane_id: "%4",
    });
    expect(store.codexStatus(42, 42, target)).toMatchObject({
      telegram_message_id: 88,
      tool_calls: 3,
      edited_files: 1,
    });
    store.close();
  });

  it("keeps update claims and owner-bound callbacks durable and private", async () => {
    const root = await temporaryRoot();
    const databasePath = path.join(root, "state.sqlite");
    let now = 1_800_000_000_000;
    const store = new ChatinaboxStore(databasePath, () => now);

    expect((await stat(databasePath)).mode & 0o777).toBe(0o600);
    expect(store.claimTelegramUpdate(10)).toBe(true);
    expect(store.claimTelegramUpdate(10)).toBe(false);
    store.releaseTelegramUpdate(10);
    expect(store.claimTelegramUpdate(10)).toBe(true);

    const callbacks = store.callbackStore();
    const issued = await issueCallbackReference(callbacks, {
      action: "codex.attach",
      chatId: 42,
      userId: 42,
      payload: { paneId: "%4" },
      ttlMs: 1_000,
      now,
    });
    await expect(parseCallbackReference(callbacks, issued.callbackData, {
      chatId: 42,
      userId: 43,
      now,
    })).resolves.toMatchObject({ ok: false, reason: "USER_MISMATCH" });
    now += 1_001;
    await expect(parseCallbackReference(callbacks, issued.callbackData, {
      chatId: 42,
      userId: 42,
      now,
    })).resolves.toMatchObject({ ok: false, reason: "NOT_FOUND" });
    store.close();
  });

  it("persists session routing, queued prompts, statuses, and final dedupe", async () => {
    const root = await temporaryRoot();
    let now = 1_800_000_000_000;
    const store = new ChatinaboxStore(path.join(root, "state.sqlite"), () => now);
    const pane = {
      serverPid: 100,
      paneId: "%4",
      panePid: 200,
      sessionName: "codex",
      windowName: "chatinabox",
      windowIndex: 2,
      cwd: "/root/chatinabox",
      active: true,
      busy: false,
      codexPid: 300,
    };

    expect(store.attachCodex(42, 42, pane)).toMatchObject({ pane_id: "%4" });
    expect(store.codexAttachment(42, 43)).toBeNull();
    store.recordCodexPrompt(42, 42, pane, 77);
    const pending = store.nextCodexPrompt(42, 42, pane)!;
    expect(pending.telegram_message_id).toBe(77);
    store.markCodexPromptDelivered(pending.id);
    expect(store.nextCodexPrompt(42, 42, pane)).toBeNull();

    expect(store.queueCodexPrompt(42, 42, pane, 78, "first")).toBe(1);
    now += 10;
    expect(store.queueCodexPrompt(42, 42, pane, 79, "second")).toBe(2);
    expect(store.queuedCodexPrompts(42, 42, pane).map((row) => row.text))
      .toEqual(["first", "second"]);

    store.setCodexStatus(42, 42, pane, 88, {
      statusKind: "state_waiting_terminal",
      toolCalls: 4,
      editedFiles: 2,
      exploredThings: 3,
      activeShells: 1,
      queuedMessages: 2,
      replyToMessageId: 79,
      startedAt: now - 5_000,
    });
    expect(store.clearCodexStatus(42, 42, pane)).toMatchObject({
      telegram_message_id: 88,
      status_kind: "state_waiting_terminal",
      tool_calls: 4,
      edited_files: 2,
      explored_things: 3,
      active_shells: 1,
      queued_messages: 2,
      reply_to_message_id: 79,
    });
    store.setCodexQueueStatus(42, 42, pane, 89, 2);
    expect(store.clearCodexQueueStatus(42, 42, pane)?.message_count).toBe(2);
    expect(store.addCodexSessionWork("session", "turn-1", 5_000)).toBe(5_000);
    expect(store.addCodexSessionWork("session", "turn-1", 5_000)).toBe(5_000);
    expect(store.addCodexSessionWork("session", "turn-2", 2_000)).toBe(7_000);

    store.recordCodexFinalDelivery(42, 42, pane, "same-final");
    expect(store.isRecentDuplicateCodexFinal(42, 42, pane, "same-final"))
      .toBe(true);
    now += 30_001;
    expect(store.isRecentDuplicateCodexFinal(42, 42, pane, "same-final"))
      .toBe(false);
    expect(store.detachCodex(42, 42)).toBe(true);
    store.close();
  });

  it("keeps an overview isolated from Codex routing and persists its card", async () => {
    const root = await temporaryRoot();
    const databasePath = path.join(root, "state.sqlite");
    const store = new ChatinaboxStore(databasePath, () => 1_800_000_000_000);
    const pane = {
      serverPid: 100,
      paneId: "%4",
      panePid: 200,
      sessionName: "codex",
      windowName: "worker",
      windowIndex: 0,
      cwd: "/root",
      active: true,
      busy: false,
      codexPid: 300,
    };

    store.attachCodex(-10042, 42, pane);
    expect(store.detachCodex(-10042, 42)).toBe(true);
    store.registerOverview(-10042, 42, 1);
    store.setOverviewDashboardMessage(-10042, 77, "live-signature");
    store.registerManagerTopic(-10042, 42, 2);
    store.setManagerTarget(-10042, pane);
    const secondPane = {
      ...pane,
      paneId: "%5",
      panePid: 201,
      windowName: "second worker",
    };
    store.attachCodex(-10042, 42, pane, 2);
    store.attachCodex(-10042, 42, secondPane, 3);
    store.setCodexStatus(-10042, 42, pane, 88);
    store.setCodexStatus(-10042, 42, secondPane, 89);
    expect(store.isOverviewChat(-10042)).toBe(true);
    expect(store.codexAttachment(-10042, 42)).toBeNull();
    expect(store.overviewDashboard(-10042)).toMatchObject({
      owner_user_id: 42,
      message_thread_id: 1,
      dashboard_message_id: 77,
      render_signature: "live-signature",
    });
    expect(store.managerTopic(-10042)).toMatchObject({
      owner_user_id: 42,
      message_thread_id: 2,
      pane_id: "%4",
    });
    expect(store.codexAttachment(-10042, 42, 2)?.pane_id).toBe("%4");
    expect(store.codexAttachment(-10042, 42, 3)?.pane_id).toBe("%5");
    expect(store.codexStatus(-10042, 42, pane)?.telegram_message_id).toBe(88);
    expect(store.codexStatus(-10042, 42, secondPane)?.telegram_message_id)
      .toBe(89);
    expect(store.detachCodex(-10042, 42, 2)).toBe(true);
    expect(store.codexAttachment(-10042, 42, 3)?.pane_id).toBe("%5");
    store.close();

    const reopened = new ChatinaboxStore(databasePath);
    expect(reopened.overviewDashboards()).toHaveLength(1);
    expect(reopened.overviewDashboard(-10042)?.dashboard_message_id).toBe(77);
    expect(reopened.managerTopic(-10042)?.message_thread_id).toBe(2);
    reopened.close();
  });
});
