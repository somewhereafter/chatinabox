import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

    store.setCodexStatus(42, 42, pane, 88);
    expect(store.clearCodexStatus(42, 42, pane)?.telegram_message_id).toBe(88);
    store.setCodexQueueStatus(42, 42, pane, 89, 2);
    expect(store.clearCodexQueueStatus(42, 42, pane)?.message_count).toBe(2);

    store.recordCodexFinalDelivery(42, 42, pane, "same-final");
    expect(store.isRecentDuplicateCodexFinal(42, 42, pane, "same-final"))
      .toBe(true);
    now += 30_001;
    expect(store.isRecentDuplicateCodexFinal(42, 42, pane, "same-final"))
      .toBe(false);
    expect(store.detachCodex(42, 42)).toBe(true);
    store.close();
  });
});
