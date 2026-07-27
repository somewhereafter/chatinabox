import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexTelegramController,
  buildCodexAttachmentPrompt,
  buildBundledTelegramPrompt,
  buildTelegramTextPrompt,
  codexHelpText,
  formatCodexActivityStatus,
  formatAgentReasoningRichMarkdown,
  formatCodexEvent,
  formatGoalEditPrompt,
  formatCodexQueuedUntilToolStatus,
  formatCodexRichMarkdown,
  formatCodexTransientRichHtml,
  formatThinkingSectionRichHtml,
  parseArrowShortcut,
  sanitizeAttachmentFileName,
  selectTelegramMedia,
  visibleCodexGoal,
  promptsReadByTurn,
} from "../src/vps/codex-telegram";
import type { TelegramMessage } from "../src/telegram-types";
import {
  DEFAULT_EXPERIENCE_PROFILE,
  patchExperienceProfile,
} from "../src/vps/experience-profile";
import { ChatinaboxStore } from "../src/vps/store";

const temporaryRoots: string[] = [];
const personalProfile = patchExperienceProfile(DEFAULT_EXPERIENCE_PROFILE, {
  setupComplete: true,
  assistant: { name: "mori", mark: "✦" },
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function message(
  overrides: Partial<TelegramMessage>,
): TelegramMessage {
  return {
    message_id: 42,
    chat: { id: 1 },
    from: { id: 2 },
    date: 1,
    ...overrides,
  };
}

describe("Codex Telegram attachments", () => {
  it("wraps final answers in the configured shell with compact details", () => {
    const event = {
      id: 1,
      kind: "assistant_final" as const,
      target: { serverPid: 1, paneId: "%1", panePid: 2 },
      sessionId: "session",
      turnId: "turn",
      assistantName: "Sol" as const,
      message: "Finished.",
      createdAt: 1,
    };
    expect(formatCodexEvent(event, personalProfile)[0])
      .toContain("<b>mori ✦</b>");
    expect(formatCodexEvent(event, personalProfile)[0]).toContain("<i>fin</i>");
    const rich = formatCodexRichMarkdown(event, {
      model: "sol",
      reasoningEffort: "high",
      fast: true,
      cwd: "/root/chatinabox",
      turnElapsedMs: 134_000,
      totalWorkMs: 2_160_000,
      contextUsedPercent: 42,
    }, personalProfile);
    expect(rich).toContain("==mori ✦==");
    expect(rich).toContain("<details><summary>details</summary>");
    expect(rich).toContain("`sol · high · fast`");
    expect(rich).toContain("`⌂ /root/chatinabox`");
    expect(rich).toContain(
      "`turn 2m 14s · total 36m · context rem. 58%`",
    );
    expect(rich).toContain("<footer>fin</footer>");
    const lobbyEvent = { ...event, assistantName: "Lobby" as const };
    expect(formatCodexEvent(lobbyEvent, personalProfile)[0])
      .toContain("<b>mori ✦</b>");
    expect(formatCodexRichMarkdown({
      ...lobbyEvent,
      kind: "assistant_progress",
    }, undefined, personalProfile)).toContain("<footer>cont.</footer>");
  });

  it("renders sequential reasoning inside one expandable thinking section", () => {
    expect(formatAgentReasoningRichMarkdown(
      "**Inspecting the queue state**",
    )).toBe("==*Inspecting the queue state... 🪄*==");
    const thinking = formatThinkingSectionRichHtml({
      summaries_json: JSON.stringify([
        "**Inspecting the queue state**",
        "Checking ordering...",
      ]),
      omitted_count: 1,
    });
    expect(thinking).toContain("<details><summary>show thinking</summary>");
    expect(thinking).toContain("1 earlier thought omitted");
    expect(thinking.match(/<mark>/gu)).toHaveLength(2);
    expect(thinking).toContain(
      "<p><mark><i>Inspecting the queue state</i></mark></p>",
    );
    expect(thinking).toContain(
      "<p><mark><i>Checking ordering</i></mark></p>",
    );
    expect(thinking).not.toContain("•");
  });

  it("keeps native goal state inside the live transient", () => {
    const html = formatCodexTransientRichHtml({
      statusKind: "state_goal",
      toolCalls: 0,
      editedFiles: 0,
      exploredThings: 0,
      activeShells: 0,
      queuedMessages: 0,
      replyToMessageId: null,
      startedAt: 1,
    }, 2, personalProfile, {
      objective: "Ship goal mode across Telegram and terminal",
      status: "paused",
      token_budget: 50_000,
      tokens_used: 12_000,
      time_used_seconds: 90,
    });

    expect(html).toContain("<mark>🎯 goal · paused</mark>");
    expect(html).toContain("Ship goal mode across Telegram and terminal");
    expect(html).toContain("12,000 / 50,000 tokens · 1m 30s");

    const interrupting = formatCodexTransientRichHtml({
      statusKind: "state_interrupting",
      toolCalls: 2,
      editedFiles: 0,
      exploredThings: 0,
      activeShells: 0,
      queuedMessages: 0,
      replyToMessageId: null,
      startedAt: 1,
    }, 2, personalProfile, null);
    expect(interrupting).toContain("<mark>■ interrupt requested</mark>");

    const interrupted = formatCodexTransientRichHtml({
      statusKind: "state_interrupted",
      toolCalls: 2,
      editedFiles: 0,
      exploredThings: 0,
      activeShells: 0,
      queuedMessages: 0,
      replyToMessageId: null,
      startedAt: 1,
    }, 2, personalProfile, null);
    expect(interrupted).toContain("<mark>■ task interrupted</mark>");
  });

  it("makes goal edit mode visible and preserves the current objective", () => {
    const prompt = formatGoalEditPrompt({
      chat_id: -10042,
      owner_user_id: 42,
      message_thread_id: 7,
      thread_id: "thread",
      objective: "Keep this objective until replacement succeeds",
      status: "paused",
      token_budget: null,
      tokens_used: 1_000,
      time_used_seconds: 20,
      goal_created_at: 100,
      goal_updated_at: 200,
      observed_at: 300,
      awaiting_edit: 1,
    });

    expect(prompt).toContain("<mark>✏️ editing goal</mark>");
    expect(prompt).toContain("Send the replacement objective");
    expect(prompt).toContain(
      "Keep this objective until replacement succeeds",
    );
  });

  it("keeps completed goals out of later live transients", () => {
    const complete = {
      chat_id: -10042,
      owner_user_id: 42,
      message_thread_id: 7,
      thread_id: "thread",
      objective: "Already finished",
      status: "complete" as const,
      token_budget: null,
      tokens_used: 1_000,
      time_used_seconds: 20,
      goal_created_at: 100,
      goal_updated_at: 200,
      observed_at: 300,
      awaiting_edit: 0,
    };
    expect(visibleCodexGoal(complete)).toBeNull();
    expect(visibleCodexGoal({ ...complete, status: "paused" }))
      .toMatchObject({ status: "paused" });
  });

  it("selects the largest Telegram photo variant", () => {
    expect(selectTelegramMedia(message({
      photo: [
        {
          file_id: "small",
          file_unique_id: "s",
          width: 320,
          height: 240,
          file_size: 12_000,
        },
        {
          file_id: "large",
          file_unique_id: "l",
          width: 1_920,
          height: 1_080,
          file_size: 400_000,
        },
      ],
    }))).toEqual({
      fileId: "large",
      fileName: "photo.jpg",
      mimeType: "image/jpeg",
      declaredBytes: 400_000,
      kind: "image",
    });
  });

  it("preserves useful filenames without allowing path traversal", () => {
    expect(sanitizeAttachmentFileName("../../my report (final).pdf"))
      .toBe("_my_report_final_.pdf");
    expect(sanitizeAttachmentFileName("\u0000/..")).toBe("attachment.bin");
  });

  it("builds one Codex turn for multiple attachments and a caption", () => {
    const prompt = buildCodexAttachmentPrompt([
      {
        path: "/var/lib/chatinabox/codex-attachments/id/01-photo.jpg",
        fileName: "01-photo.jpg",
        mimeType: "image/jpeg",
        bytes: 123,
        kind: "image",
      },
      {
        path: "/var/lib/chatinabox/codex-attachments/id/02-notes.pdf",
        fileName: "02-notes.pdf",
        mimeType: "application/pdf",
        bytes: 456,
        kind: "file",
      },
    ], "Compare these and explain the difference.");

    expect(prompt).toContain("1. /var/lib/chatinabox/");
    expect(prompt).toContain("2. /var/lib/chatinabox/");
    expect(prompt).toContain("Sent from Telegram");
    expect(prompt).not.toContain("Telegram user");
    expect(prompt).toContain("use the image viewer for images");
    expect(prompt).toContain("Compare these and explain the difference.");
  });

  it("passes one message through unchanged and bundles message bursts in order", () => {
    expect(buildBundledTelegramPrompt(["one message"])).toBe("one message");
    const bundled = buildBundledTelegramPrompt([
      "first thought",
      "and one more detail",
    ]);
    expect(bundled).toContain("--- Message 1 ---\nfirst thought");
    expect(bundled).toContain("--- Message 2 ---\nand one more detail");
    expect(bundled.indexOf("first thought"))
      .toBeLessThan(bundled.indexOf("and one more detail"));
  });

  it("adds a short quoted-reply reference without copying an entire message", () => {
    const prompt = buildTelegramTextPrompt(message({
      text: "This is the part I mean.",
      reply_to_message: message({
        message_id: 41,
        from: { id: 9, is_bot: true, first_name: "Sol" },
        text: "A".repeat(400),
      }),
    }));
    expect(prompt).toContain("Sent from Telegram in reply to Sol:");
    expect(prompt).toContain("This is the part I mean.");
    expect(prompt).toContain("…");
    expect(prompt.length).toBeLessThan(380);
  });

  it("formats accumulating Codex activity with natural plurals", () => {
    expect(formatCodexActivityStatus("1\u001f1")).toContain(
      "✨ ran <b>1</b> cmd · 📝 edited <b>1</b> file",
    );
    expect(formatCodexActivityStatus("12\u001f3\u001f5\u001f2")).toContain(
      "✨ ran <b>12</b> cmds · 📝 edited <b>3</b> files",
    );
    expect(formatCodexActivityStatus("12\u001f3\u001f5\u001f2")).toContain(
      "🔎 explored <b>5</b> things",
    );
    expect(formatCodexActivityStatus("12\u001f3\u001f5\u001f2")).toContain(
      "🖥️ <b>2</b> active shells",
    );
    expect(formatCodexActivityStatus("not counters")).toBeNull();
    expect(formatCodexActivityStatus("2\u001f0", "Sol", personalProfile)).toContain(
      "<b>mori ✦ is working…</b>",
    );
    expect(formatCodexActivityStatus("2\u001f0", "Sol", personalProfile))
      .not.toContain(
      "edited",
    );
    expect(formatCodexActivityStatus("2\u001f0", "Lobby", personalProfile))
      .toContain(
      "<b>mori ✦ is working…</b>",
    );
  });

  it("formats the busy-turn steering queue with natural plurals", () => {
    expect(formatCodexQueuedUntilToolStatus(1)).toBe(
      "📥 <b>1</b> msg queued",
    );
    expect(formatCodexQueuedUntilToolStatus(3)).toBe(
      "📥 <b>3</b> msgs queued",
    );
  });

  it("keeps shell and queue counts together with terminal waiting last", () => {
    const html = formatCodexTransientRichHtml({
      statusKind: "state_waiting_terminal",
      toolCalls: 4,
      editedFiles: 2,
      exploredThings: 3,
      activeShells: 2,
      queuedMessages: 2,
      replyToMessageId: 100,
      startedAt: 1,
    }, 121_001, personalProfile);
    expect(html).toContain(
      "<mark>mori ✦ is working for 2m 1s…</mark>",
    );
    expect(html).toContain(
      "✨ ran <b>4</b> cmds · 📝 edited <b>2</b> files",
    );
    expect(html).toContain("🔎 explored <b>3</b> things");
    expect(html).toContain(
      "🖥️ <b>2</b> active shells · 📥 <b>2</b> msgs queued",
    );
    expect(html.indexOf("🔎 explored")).toBeLessThan(
      html.indexOf("🖥️ <b>2</b>"),
    );
    expect(html).not.toContain("<mark>2");
    expect(html).not.toContain("<footer>");
    expect(html.endsWith("<i>⏳ waiting on a terminal…</i></p>")).toBe(true);
  });

  it("hides zero-value edited-file activity", () => {
    const html = formatCodexTransientRichHtml({
      statusKind: "state_working",
      toolCalls: 2,
      editedFiles: 0,
      exploredThings: 0,
      activeShells: 0,
      queuedMessages: 0,
      replyToMessageId: 100,
      startedAt: 1,
    });
    expect(html).toContain("✨ ran <b>2</b> cmds");
    expect(html).not.toContain("edited");
  });

  it("can force settings back to Lobby from an attached worker", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chatinabox-lobby-"));
    temporaryRoots.push(root);
    const store = new ChatinaboxStore(path.join(root, "state.sqlite"));
    const worker = {
      serverPid: 100,
      paneId: "%4",
      panePid: 200,
      sessionName: "codex",
      windowName: "worker",
      windowIndex: 0,
      cwd: "/root/work",
      active: true,
      busy: false,
      codexPid: 300,
      assistantName: "Sol" as const,
    };
    const lobby = {
      ...worker,
      paneId: "%5",
      panePid: 201,
      codexPid: 301,
      windowName: "🪄 Lobby",
      assistantName: "Lobby" as const,
    };
    store.attachCodex(42, 42, worker);
    const bridge = {
      request: vi.fn(async () => ({ ok: true, pane: lobby })),
    };
    const controller = new CodexTelegramController({
      env: {
        TG_BOT_TOKEN: "test-token",
        TG_ALLOWED_USER_IDS: "42",
        DATA_DIR: root,
        CODEX_BRIDGE_SOCKET: path.join(root, "bridge.sock"),
        DEFAULT_CWD: root,
      },
      store,
      bridge: bridge as never,
    });

    expect(await controller.ensureLobbyAttached(42, 42)).toBe(true);
    expect(bridge.request).not.toHaveBeenCalled();
    expect(await controller.ensureLobbyAttached(42, 42, 0, true)).toBe(true);
    expect(bridge.request).toHaveBeenCalledWith({ op: "lobby" });
    expect(store.codexAttachment(42, 42)?.assistant_name).toBe("Lobby");
    store.close();
  });

  it("pins completed topic responses as ordered navigable checkpoints", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chatinabox-pins-"));
    temporaryRoots.push(root);
    const store = new ChatinaboxStore(path.join(root, "state.sqlite"));
    const pane = {
      serverPid: 100,
      paneId: "%4",
      panePid: 200,
      sessionName: "codex",
      windowName: "checkpoints",
      windowIndex: 0,
      cwd: "/root",
      active: true,
      busy: false,
      codexPid: 300,
      assistantName: "Sol" as const,
      sessionId: "session",
    };
    store.attachCodex(-10042, 42, pane, 7);
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    let nextMessageId = 900;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = url.split("/").pop() ?? "";
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ method, body });
      return {
        json: async () => ({
          ok: true,
          result: method === "pinChatMessage"
            ? true
            : { message_id: nextMessageId++ },
        }),
      };
    }));
    const events = [
      {
        id: 1,
        kind: "assistant_final" as const,
        target: { serverPid: 100, paneId: "%4", panePid: 200 },
        sessionId: "session",
        turnId: "turn-1",
        assistantName: "Sol" as const,
        message: "First checkpoint.",
        createdAt: 1_000,
      },
      {
        id: 2,
        kind: "assistant_final" as const,
        target: { serverPid: 100, paneId: "%4", panePid: 200 },
        sessionId: "session",
        turnId: "turn-2",
        assistantName: "Sol" as const,
        message: "Second checkpoint.",
        createdAt: 2_000,
      },
    ];
    const acknowledged: number[] = [];
    const bridge = {
      request: vi.fn(async (request: { op: string; eventId?: number }) => {
        if (request.op === "events") return { ok: true, events };
        if (request.op === "ack") {
          acknowledged.push(request.eventId!);
          return { ok: true, acknowledged: true };
        }
        throw new Error(`Unexpected request: ${request.op}`);
      }),
    };
    const controller = new CodexTelegramController({
      env: {
        TG_BOT_TOKEN: "test-token",
        TG_ALLOWED_USER_IDS: "42",
        DATA_DIR: root,
        CODEX_BRIDGE_SOCKET: path.join(root, "bridge.sock"),
        DEFAULT_CWD: root,
      },
      store,
      bridge: bridge as never,
    });

    await controller.deliverEventsOnce();

    expect(calls.filter((call) => call.method === "pinChatMessage"))
      .toEqual([
        {
          method: "pinChatMessage",
          body: {
            chat_id: -10042,
            message_id: 900,
            disable_notification: true,
          },
        },
        {
          method: "pinChatMessage",
          body: {
            chat_id: -10042,
            message_id: 901,
            disable_notification: true,
          },
        },
      ]);
    expect(acknowledged).toEqual([1, 2]);
    store.close();
  });

  it("syncs native goals into one transient and a durable completion event", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chatinabox-goals-"));
    temporaryRoots.push(root);
    const store = new ChatinaboxStore(path.join(root, "state.sqlite"));
    const pane = {
      serverPid: 100,
      paneId: "%4",
      panePid: 200,
      sessionName: "codex",
      windowName: "goals",
      windowIndex: 0,
      cwd: "/root",
      active: true,
      busy: true,
      codexPid: 300,
      assistantName: "Sol" as const,
      sessionId: "thread-goal",
    };
    store.attachCodex(-10042, 42, pane, 7);
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    let nextMessageId = 1_200;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = url.split("/").pop() ?? "";
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ method, body });
      return {
        json: async () => ({
          ok: true,
          result: method === "editMessageText" || method === "deleteMessage"
            ? true
            : { message_id: nextMessageId++ },
        }),
      };
    }));
    let status: "active" | "complete" = "active";
    const bridge = {
      request: vi.fn(async () => ({
        ok: true,
        goals: [{
          target: {
            serverPid: pane.serverPid,
            paneId: pane.paneId,
            panePid: pane.panePid,
          },
          threadId: "thread-goal",
          goal: {
            threadId: "thread-goal",
            objective: "Ship native goals",
            status,
            tokenBudget: 50_000,
            tokensUsed: status === "active" ? 12_000 : 24_000,
            timeUsedSeconds: status === "active" ? 60 : 180,
            createdAt: 100,
            updatedAt: status === "active" ? 200 : 300,
          },
        }],
      })),
    };
    const controller = new CodexTelegramController({
      env: {
        TG_BOT_TOKEN: "test-token",
        TG_ALLOWED_USER_IDS: "42",
        DATA_DIR: root,
        CODEX_BRIDGE_SOCKET: path.join(root, "bridge.sock"),
        DEFAULT_CWD: root,
      },
      store,
      bridge: bridge as never,
    });

    await controller.syncGoalsOnce();
    expect(store.codexGoal(-10042, 42, 7)).toMatchObject({
      status: "active",
      objective: "Ship native goals",
    });
    expect(store.codexStatus(
      -10042,
      42,
      { serverPid: 100, paneId: "%4", panePid: 200 },
    )).toMatchObject({ status_kind: "state_goal" });
    expect(calls.some((call) =>
      JSON.stringify(call.body).includes("Ship native goals")
    )).toBe(true);

    const firstTransient = store.clearCodexStatus(
      -10042,
      42,
      { serverPid: 100, paneId: "%4", panePid: 200 },
    );
    expect(firstTransient).not.toBeNull();
    const sendsBeforeResync = calls.filter(
      (call) => call.method === "sendRichMessage",
    ).length;
    await controller.syncGoalsOnce();
    expect(store.codexStatus(
      -10042,
      42,
      { serverPid: 100, paneId: "%4", panePid: 200 },
    )).toMatchObject({ status_kind: "state_goal" });
    expect(calls.filter((call) => call.method === "sendRichMessage").length)
      .toBe(sendsBeforeResync + 1);

    status = "complete";
    await controller.syncGoalsOnce();
    expect(store.pendingCodexGoalCompletions()).toHaveLength(0);
    expect(store.recentCompletedCodexGoals(-10042)).toHaveLength(1);
    expect(store.codexStatus(
      -10042,
      42,
      { serverPid: 100, paneId: "%4", panePid: 200 },
    )).toBeNull();
    expect(calls.some((call) =>
      JSON.stringify(call.body).includes("goal complete")
    )).toBe(true);
    store.close();
  });

  it("keeps goal editing visible through activity and reanchors it after a final", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chatinabox-goal-edit-"));
    temporaryRoots.push(root);
    const store = new ChatinaboxStore(path.join(root, "state.sqlite"));
    const pane = {
      serverPid: 100,
      paneId: "%4",
      panePid: 200,
      sessionName: "codex",
      windowName: "goal-edit",
      windowIndex: 0,
      cwd: "/root",
      active: true,
      busy: true,
      codexPid: 300,
      assistantName: "Sol" as const,
      sessionId: "thread-goal",
    };
    store.attachCodex(-10042, 42, pane, 7);
    store.observeCodexGoal(-10042, 42, 7, {
      threadId: "thread-goal",
      objective: "Keep this editor open",
      status: "paused",
      tokenBudget: null,
      tokensUsed: 12_000,
      timeUsedSeconds: 60,
      createdAt: 100,
      updatedAt: 200,
    });
    store.setCodexGoalAwaitingEdit(-10042, 42, 7, true);
    store.setCodexStatus(-10042, 42, pane, 700, {
      statusKind: "state_working",
      toolCalls: 0,
      editedFiles: 0,
      exploredThings: 0,
      activeShells: 0,
      queuedMessages: 0,
      replyToMessageId: 650,
      startedAt: 1_000,
    });
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    let nextMessageId = 1_000;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = url.split("/").pop() ?? "";
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ method, body });
      return {
        json: async () => ({
          ok: true,
          result:
            method === "deleteMessage" || method === "pinChatMessage"
              ? true
              : { message_id: nextMessageId++ },
        }),
      };
    }));
    const events = [
      {
        id: 1,
        kind: "state_activity" as const,
        target: pane,
        sessionId: "thread-goal",
        turnId: "turn",
        assistantName: "Sol" as const,
        message: "4\u001f2\u001f3\u001f1",
        createdAt: 2_000,
      },
      {
        id: 2,
        kind: "assistant_final" as const,
        target: pane,
        sessionId: "thread-goal",
        turnId: "turn",
        assistantName: "Sol" as const,
        message: "Paused successfully.",
        createdAt: 3_000,
      },
    ];
    const bridge = {
      request: vi.fn(async (request: { op: string }) => {
        if (request.op === "events") return { ok: true, events };
        if (request.op === "ack") return { ok: true, acknowledged: true };
        throw new Error(`Unexpected request: ${request.op}`);
      }),
    };
    const controller = new CodexTelegramController({
      env: {
        TG_BOT_TOKEN: "test-token",
        TG_ALLOWED_USER_IDS: "42",
        DATA_DIR: root,
        CODEX_BRIDGE_SOCKET: path.join(root, "bridge.sock"),
        DEFAULT_CWD: root,
      },
      store,
      bridge: bridge as never,
    });

    await controller.deliverEventsOnce();

    expect(calls.some((call) => call.method === "editMessageText")).toBe(false);
    const richSends = calls.filter((call) => call.method === "sendRichMessage");
    expect(richSends).toHaveLength(2);
    expect(JSON.stringify(richSends[0]?.body)).toContain("Paused successfully.");
    expect(JSON.stringify(richSends[1]?.body)).toContain("editing goal");
    expect(JSON.stringify(richSends[1]?.body)).toContain(
      "Keep this editor open",
    );
    expect(calls.at(-1)).toMatchObject({
      method: "deleteMessage",
      body: { message_id: 700 },
    });
    expect(store.codexStatus(-10042, 42, pane)).toMatchObject({
      telegram_message_id: 1_001,
      tool_calls: 4,
      edited_files: 2,
      explored_things: 3,
      active_shells: 1,
    });
    expect(store.codexGoal(-10042, 42, 7)?.awaiting_edit).toBe(1);
    store.close();
  });

  it("coalesces activity bursts and throttles transient edits without losing counters", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chatinabox-activity-"));
    temporaryRoots.push(root);
    let now = 1_800_000_000_000;
    const store = new ChatinaboxStore(
      path.join(root, "state.sqlite"),
      () => now,
    );
    const pane = {
      serverPid: 100,
      paneId: "%4",
      panePid: 200,
      sessionName: "codex",
      windowName: "activity",
      windowIndex: 0,
      cwd: "/root",
      active: true,
      busy: true,
      codexPid: 300,
      assistantName: "Sol" as const,
      sessionId: "session",
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
      startedAt: now - 1_000,
    });
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = url.split("/").pop() ?? "";
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ method, body });
      return { json: async () => ({ ok: true, result: true }) };
    }));
    let events = [1, 2, 3].map((id) => ({
      id,
      kind: "state_activity" as const,
      target: pane,
      sessionId: "session",
      turnId: "turn",
      assistantName: "Sol" as const,
      message: `${id}\u001f0\u001f${id}\u001f0`,
      createdAt: now,
    }));
    const acknowledged: number[] = [];
    const bridge = {
      request: vi.fn(async (
        request: { op: string; eventId?: number },
      ) => {
        if (request.op === "events") return { ok: true, events };
        if (request.op === "ack") {
          acknowledged.push(request.eventId!);
          return { ok: true, acknowledged: true };
        }
        throw new Error(`Unexpected request: ${request.op}`);
      }),
    };
    const controller = new CodexTelegramController({
      env: {
        TG_BOT_TOKEN: "test-token",
        TG_ALLOWED_USER_IDS: "42",
        DATA_DIR: root,
        CODEX_BRIDGE_SOCKET: path.join(root, "bridge.sock"),
        DEFAULT_CWD: root,
      },
      store,
      bridge: bridge as never,
      now: () => now,
    });

    await controller.deliverEventsOnce();
    expect(calls.filter((call) => call.method === "editMessageText"))
      .toHaveLength(1);
    expect(acknowledged).toEqual([1, 2, 3]);
    expect(store.codexStatus(-10042, 42, pane)).toMatchObject({
      tool_calls: 3,
      explored_things: 3,
    });

    calls.length = 0;
    now += 1_000;
    events = [{
      ...events[0],
      id: 4,
      message: "4\u001f1\u001f4\u001f0",
      createdAt: now,
    }];
    await controller.deliverEventsOnce();
    expect(calls).toHaveLength(0);
    expect(store.codexStatus(-10042, 42, pane)).toMatchObject({
      telegram_message_id: 700,
      tool_calls: 4,
      edited_files: 1,
      explored_things: 4,
    });
    store.close();
  });

  it("refreshes a silent working timer every fifteen seconds without faking activity", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chatinabox-heartbeat-"));
    temporaryRoots.push(root);
    let now = 1_800_000_000_000;
    const store = new ChatinaboxStore(
      path.join(root, "state.sqlite"),
      () => now,
    );
    const pane = {
      serverPid: 100,
      paneId: "%4",
      panePid: 200,
      sessionName: "codex",
      windowName: "heartbeat",
      windowIndex: 0,
      cwd: "/root",
      active: true,
      busy: true,
      codexPid: 300,
      assistantName: "Sol" as const,
      sessionId: "session",
    };
    store.attachCodex(-10042, 42, pane, 7);
    store.setCodexStatus(-10042, 42, pane, 700, {
      statusKind: "state_waiting_terminal",
      toolCalls: 1,
      editedFiles: 0,
      exploredThings: 2,
      activeShells: 1,
      queuedMessages: 0,
      replyToMessageId: 650,
      startedAt: now - 60_000,
    });
    const actualUpdatedAt =
      store.codexStatus(-10042, 42, pane)!.updated_at;
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = url.split("/").pop() ?? "";
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ method, body });
      return { json: async () => ({ ok: true, result: true }) };
    }));
    const controller = new CodexTelegramController({
      env: {
        TG_BOT_TOKEN: "test-token",
        TG_ALLOWED_USER_IDS: "42",
        DATA_DIR: root,
        CODEX_BRIDGE_SOCKET: path.join(root, "bridge.sock"),
        DEFAULT_CWD: root,
      },
      store,
      bridge: { request: vi.fn() } as never,
      now: () => now,
    });

    now += 14_999;
    await controller.refreshStaleTransientTimersOnce();
    expect(calls).toHaveLength(0);

    now += 1;
    await controller.refreshStaleTransientTimersOnce();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("editMessageText");
    expect(JSON.stringify(calls[0]?.body)).toContain("1m 15s");
    expect(JSON.stringify(calls[0]?.body)).not.toContain("since update");
    expect(store.codexStatus(-10042, 42, pane)?.updated_at)
      .toBe(actualUpdatedAt);

    now += 5_000;
    await controller.refreshStaleTransientTimersOnce();
    expect(calls).toHaveLength(1);

    now += 10_000;
    await controller.refreshStaleTransientTimersOnce();
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1]?.body)).toContain("1m 30s");
    store.close();
  });

  it("batches thoughts, then flushes them before continuation and final messages", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chatinabox-thinking-"));
    temporaryRoots.push(root);
    let now = 1_800_000_000_000;
    const store = new ChatinaboxStore(
      path.join(root, "state.sqlite"),
      () => now,
    );
    const pane = {
      serverPid: 100,
      paneId: "%4",
      panePid: 200,
      sessionName: "codex",
      windowName: "thinking-order",
      windowIndex: 0,
      cwd: "/root",
      active: true,
      busy: true,
      codexPid: 300,
      assistantName: "Sol" as const,
      sessionId: "session",
    };
    store.attachCodex(-10088, 42, pane, 7);
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    let nextMessageId = 1_000;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = url.split("/").pop() ?? "";
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ method, body });
      return {
        json: async () => ({
          ok: true,
          result:
            method === "editMessageText" ||
              method === "deleteMessage" ||
              method === "pinChatMessage"
              ? true
              : { message_id: nextMessageId++ },
        }),
      };
    }));
    const events: Array<{
      id: number;
      kind: "agent_reasoning" | "assistant_progress" | "assistant_final";
      target: typeof pane;
      sessionId: string;
      turnId: string;
      assistantName: "Sol";
      message: string;
      createdAt: number;
    }> = [];
    const acknowledged = new Set<number>();
    const bridge = {
      request: vi.fn(async (request: { op: string; eventId?: number }) => {
        if (request.op === "events") {
          return {
            ok: true,
            events: events.filter((event) => !acknowledged.has(event.id)),
          };
        }
        if (request.op === "ack") {
          acknowledged.add(request.eventId!);
          return { ok: true, acknowledged: true };
        }
        throw new Error(`Unexpected request: ${request.op}`);
      }),
    };
    const controller = new CodexTelegramController({
      env: {
        TG_BOT_TOKEN: "test-token",
        TG_ALLOWED_USER_IDS: "42",
        DATA_DIR: root,
        CODEX_BRIDGE_SOCKET: path.join(root, "bridge.sock"),
        DEFAULT_CWD: root,
      },
      store,
      bridge: bridge as never,
      now: () => now,
      thinkingFlushIntervalMs: 5_000,
    });
    const addEvent = (
      kind: "agent_reasoning" | "assistant_progress" | "assistant_final",
      message: string,
    ) => {
      events.push({
        id: events.length + 1,
        kind,
        target: pane,
        sessionId: "session",
        turnId: "turn",
        assistantName: "Sol",
        message,
        createdAt: now,
      });
    };

    store.recordCodexPrompt(-10088, 42, pane, 101);
    now += 1;
    store.recordCodexPrompt(-10088, 42, pane, 102);
    addEvent("agent_reasoning", "Inspecting state");
    addEvent("agent_reasoning", "Checking ordering");
    await controller.deliverEventsOnce();
    expect(calls).toHaveLength(0);
    expect(acknowledged).toEqual(new Set([1, 2]));

    now += 5_000;
    await controller.deliverEventsOnce();
    const firstThinking = calls.find(
      (call) =>
        call.method === "sendRichMessage" &&
        JSON.stringify(call.body).includes("show thinking"),
    );
    expect(JSON.stringify(firstThinking?.body)).toContain("Inspecting state");
    expect(JSON.stringify(firstThinking?.body)).toContain("Checking ordering");
    expect(firstThinking?.body.reply_parameters).toBeUndefined();

    calls.length = 0;
    addEvent("agent_reasoning", "Preparing continuation");
    addEvent("assistant_progress", "The intermediate result.");
    await controller.deliverEventsOnce();
    expect(calls[0]?.method).toBe("editMessageText");
    expect(JSON.stringify(calls[0]?.body)).toContain("Preparing continuation");
    const continuationIndex = calls.findIndex(
      (call) =>
        call.method === "sendRichMessage" &&
        JSON.stringify(call.body).includes("<footer>cont.</footer>"),
    );
    expect(continuationIndex).toBeGreaterThan(0);
    expect(calls[continuationIndex]?.body.reply_parameters).toMatchObject({
      message_id: 102,
    });
    expect(store.codexThinkingSection(-10088, 42, pane)).toBeNull();

    calls.length = 0;
    addEvent("agent_reasoning", "Preparing final");
    addEvent("assistant_final", "The completed result.");
    await controller.deliverEventsOnce();
    const finalThinkingIndex = calls.findIndex(
      (call) =>
        call.method === "sendRichMessage" &&
        JSON.stringify(call.body).includes("show thinking"),
    );
    const finalAnswerIndex = calls.findIndex(
      (call) =>
        call.method === "sendRichMessage" &&
        JSON.stringify(call.body).includes("<footer>fin</footer>"),
    );
    expect(finalThinkingIndex).toBeGreaterThanOrEqual(0);
    expect(finalAnswerIndex).toBeGreaterThan(finalThinkingIndex);
    expect(calls[finalAnswerIndex]?.body.reply_parameters).toMatchObject({
      message_id: 101,
    });
    expect(calls.at(-1)?.method).toBe("pinChatMessage");
    store.close();
  });

  it("does not treat an explicit next-turn queue as already read", () => {
    const base = {
      id: 1,
      chat_id: 42,
      owner_user_id: 42,
      server_pid: 100,
      pane_id: "%4",
      pane_pid: 200,
      telegram_message_id: 101,
      created_at: 1_000,
      delivered_at: null,
      queued_for_next_turn: 0,
    };
    const queued = {
      ...base,
      id: 2,
      telegram_message_id: 102,
      created_at: 2_000,
      queued_for_next_turn: 1,
    };

    expect(promptsReadByTurn([base, queued], 900).map(
      (prompt) => prompt.telegram_message_id,
    )).toEqual([101]);
    expect(promptsReadByTurn([queued], 2_100).map(
      (prompt) => prompt.telegram_message_id,
    )).toEqual([102]);
  });

  it("reanchors a live transient once, then edits thinking in place", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chatinabox-thinking-"));
    temporaryRoots.push(root);
    let now = 1_800_000_000_000;
    const store = new ChatinaboxStore(
      path.join(root, "state.sqlite"),
      () => now,
    );
    const pane = {
      serverPid: 100,
      paneId: "%4",
      panePid: 200,
      sessionName: "codex",
      windowName: "thinking-status",
      windowIndex: 0,
      cwd: "/root",
      active: true,
      busy: true,
      codexPid: 300,
      assistantName: "Sol" as const,
      sessionId: "session",
    };
    store.attachCodex(-10089, 42, pane, 8);
    store.setCodexStatus(-10089, 42, pane, 700, {
      statusKind: "state_activity",
      toolCalls: 2,
      editedFiles: 1,
      exploredThings: 3,
      activeShells: 0,
      queuedMessages: 0,
      replyToMessageId: 650,
      startedAt: now - 10_000,
    });
    store.appendCodexThinkingSummary(-10089, 42, pane, "First batch");
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    let nextMessageId = 1_000;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = url.split("/").pop() ?? "";
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ method, body });
      return {
        json: async () => ({
          ok: true,
          result: method === "editMessageText" || method === "deleteMessage"
            ? true
            : { message_id: nextMessageId++ },
        }),
      };
    }));
    const bridge = {
      request: vi.fn(async (request: { op: string }) => {
        if (request.op === "events") return { ok: true, events: [] };
        throw new Error(`Unexpected request: ${request.op}`);
      }),
    };
    const controller = new CodexTelegramController({
      env: {
        TG_BOT_TOKEN: "test-token",
        TG_ALLOWED_USER_IDS: "42",
        DATA_DIR: root,
        CODEX_BRIDGE_SOCKET: path.join(root, "bridge.sock"),
        DEFAULT_CWD: root,
      },
      store,
      bridge: bridge as never,
      now: () => now,
      thinkingFlushIntervalMs: 5_000,
    });

    now += 5_000;
    await controller.deliverEventsOnce();
    expect(calls.map((call) => call.method)).toEqual([
      "sendRichMessage",
      "sendRichMessage",
      "deleteMessage",
    ]);
    expect(calls[0]?.body).toMatchObject({
      message_thread_id: 8,
    });
    expect(calls[2]?.body).toMatchObject({ message_id: 700 });
    expect(store.codexThinkingSection(-10089, 42, pane)?.telegram_message_id)
      .toBe(1_000);
    expect(store.codexStatus(-10089, 42, pane)?.telegram_message_id)
      .toBe(1_001);

    calls.length = 0;
    store.appendCodexThinkingSummary(-10089, 42, pane, "Second batch");
    now += 5_000;
    await controller.deliverEventsOnce();
    expect(calls.map((call) => call.method)).toEqual(["editMessageText"]);
    expect(calls[0]?.body).toMatchObject({ message_id: 1_000 });
    expect(JSON.stringify(calls[0]?.body)).toContain("Second batch");
    expect(store.codexStatus(-10089, 42, pane)?.telegram_message_id)
      .toBe(1_001);
    store.close();
  });

  it("recreates the transient beneath the newest queued Telegram message", async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(path.join(os.tmpdir(), "chatinabox-telegram-"));
    temporaryRoots.push(root);
    const store = new ChatinaboxStore(path.join(root, "state.sqlite"));
    const pane = {
      serverPid: 100,
      paneId: "%4",
      panePid: 200,
      sessionName: "codex",
      windowName: "chatinabox",
      windowIndex: 0,
      cwd: "/root/chatinabox",
      active: true,
      busy: true,
      codexPid: 300,
      assistantName: "Sol" as const,
      sessionId: "session",
    };
    store.attachCodex(42, 42, pane);
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    let nextMessageId = 1_000;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = url.split("/").pop() ?? "";
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ method, body });
      return {
        json: async () => ({
          ok: true,
          result: method === "deleteMessage"
            ? true
            : { message_id: nextMessageId++ },
        }),
      };
    }));
    const bridge = {
      request: vi.fn(async () => ({
        ok: true,
        sent: true,
        queuedUntilNextToolCall: true,
      })),
    };
    const controller = new CodexTelegramController({
      env: {
        TG_BOT_TOKEN: "test-token",
        TG_ALLOWED_USER_IDS: "42",
        DATA_DIR: root,
        CODEX_BRIDGE_SOCKET: path.join(root, "bridge.sock"),
        DEFAULT_CWD: root,
      },
      store,
      bridge: bridge as never,
    });

    await controller.routeAttachedMessage(message({
      message_id: 100,
      chat: { id: 42 },
      from: { id: 42 },
      text: "first",
    }));
    await controller.routeAttachedMessage(message({
      message_id: 101,
      chat: { id: 42 },
      from: { id: 42 },
      text: "second",
    }));

    const richSends = calls.filter((call) => call.method === "sendRichMessage");
    expect(richSends).toHaveLength(2);
    expect(richSends[0]?.body.reply_parameters).toMatchObject({
      message_id: 100,
    });
    expect(richSends[0]?.body.reply_markup).toMatchObject({
      inline_keyboard: [[{ text: "■ interrupt" }]],
    });
    expect(richSends[1]?.body.reply_parameters).toMatchObject({
      message_id: 101,
    });
    expect(calls.some(
      (call) =>
        call.method === "deleteMessage" &&
        call.body.message_id === 1_000,
    )).toBe(true);
    const replacementIndex = calls.findIndex(
      (call) =>
        call.method === "sendRichMessage" &&
        (
          call.body.reply_parameters as
            | { message_id?: number }
            | undefined
        )?.message_id === 101,
    );
    const deletionIndex = calls.findIndex(
      (call) =>
        call.method === "deleteMessage" &&
        call.body.message_id === 1_000,
    );
    expect(replacementIndex).toBeGreaterThanOrEqual(0);
    expect(deletionIndex).toBeGreaterThan(replacementIndex);

    await vi.advanceTimersByTimeAsync(701);
    const latestEdit = calls
      .filter((call) => call.method === "editMessageText")
      .at(-1);
    expect(JSON.stringify(latestEdit?.body)).toContain(
      "📥 <b>2</b> msgs queued",
    );
    store.close();
  });

  it("keeps the old transient when a reanchored replacement cannot be sent", async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(path.join(os.tmpdir(), "chatinabox-transient-"));
    temporaryRoots.push(root);
    const store = new ChatinaboxStore(path.join(root, "state.sqlite"));
    const pane = {
      serverPid: 100,
      paneId: "%4",
      panePid: 200,
      sessionName: "codex",
      windowName: "chatinabox",
      windowIndex: 0,
      cwd: "/root",
      active: true,
      busy: true,
      codexPid: 300,
      assistantName: "Sol" as const,
      sessionId: "session",
    };
    store.attachCodex(42, 42, pane);
    store.setCodexStatus(42, 42, pane, 700, {
      statusKind: "state_working",
      toolCalls: 1,
      editedFiles: 0,
      exploredThings: 0,
      activeShells: 0,
      queuedMessages: 0,
      replyToMessageId: 100,
      startedAt: 1,
    });
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = url.split("/").pop() ?? "";
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ method, body });
      return {
        json: async () => ({
          ok: false,
          error_code: 500,
          description: "temporary failure",
        }),
      };
    }));
    const bridge = {
      request: vi.fn(async () => ({
        ok: true,
        sent: true,
        queuedUntilNextToolCall: true,
      })),
    };
    const controller = new CodexTelegramController({
      env: {
        TG_BOT_TOKEN: "test-token",
        TG_ALLOWED_USER_IDS: "42",
        DATA_DIR: root,
        CODEX_BRIDGE_SOCKET: path.join(root, "bridge.sock"),
        DEFAULT_CWD: root,
      },
      store,
      bridge: bridge as never,
    });

    await controller.routeAttachedMessage(message({
      message_id: 101,
      chat: { id: 42 },
      from: { id: 42 },
      text: "reanchor me",
    }));

    expect(calls.some((call) => call.method === "deleteMessage")).toBe(false);
    expect(store.codexStatus(42, 42, pane)).toMatchObject({
      telegram_message_id: 700,
      reply_to_message_id: 100,
    });
    store.close();
  });

  it("deletes a superseded transient when concurrent updates race", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chatinabox-telegram-"));
    temporaryRoots.push(root);
    const store = new ChatinaboxStore(path.join(root, "state.sqlite"));
    const pane = {
      serverPid: 100,
      paneId: "%4",
      panePid: 200,
      sessionName: "codex",
      windowName: "chatinabox",
      windowIndex: 0,
      cwd: "/root/chatinabox",
      active: true,
      busy: true,
      codexPid: 300,
      assistantName: "Sol" as const,
      sessionId: "session",
    };
    store.attachCodex(42, 42, pane);
    const deleted: number[] = [];
    let richSendCount = 0;
    let releaseFirstSend!: () => void;
    const firstSendBlocked = new Promise<void>((resolve) => {
      releaseFirstSend = resolve;
    });
    let firstSendStarted!: () => void;
    const firstSendEntered = new Promise<void>((resolve) => {
      firstSendStarted = resolve;
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = url.split("/").pop() ?? "";
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (method === "sendRichMessage") {
        richSendCount += 1;
        if (richSendCount === 1) {
          firstSendStarted();
          await firstSendBlocked;
          return {
            json: async () => ({ ok: true, result: { message_id: 1_000 } }),
          };
        }
        return {
          json: async () => ({ ok: true, result: { message_id: 1_001 } }),
        };
      }
      if (method === "deleteMessage") {
        deleted.push(Number(body.message_id));
        return { json: async () => ({ ok: true, result: true }) };
      }
      return {
        json: async () => ({ ok: true, result: { message_id: 1_002 } }),
      };
    }));
    const bridge = {
      request: vi.fn(async () => ({
        ok: true,
        sent: true,
        queuedUntilNextToolCall: true,
      })),
    };
    const controller = new CodexTelegramController({
      env: {
        TG_BOT_TOKEN: "test-token",
        TG_ALLOWED_USER_IDS: "42",
        DATA_DIR: root,
        CODEX_BRIDGE_SOCKET: path.join(root, "bridge.sock"),
        DEFAULT_CWD: root,
      },
      store,
      bridge: bridge as never,
    });

    const first = controller.routeAttachedMessage(message({
      message_id: 100,
      chat: { id: 42 },
      from: { id: 42 },
      text: "first",
    }));
    await firstSendEntered;
    const second = controller.routeAttachedMessage(message({
      message_id: 101,
      chat: { id: 42 },
      from: { id: 42 },
      text: "second",
    }));
    await second;
    releaseFirstSend();
    await first;

    expect(store.codexStatus(42, 42, pane)?.telegram_message_id).toBe(1_001);
    expect(deleted).toContain(1_000);
    store.close();
  });

  it("documents every terminal key and stays within one Telegram message", () => {
    const help = codexHelpText();
    for (const key of [
      "esc",
      "enter",
      "up",
      "down",
      "left",
      "right",
      "tab",
      "backtab",
      "pageup",
      "pagedown",
      "home",
      "end",
      "backspace",
      "space",
      "ctrl-c",
      "ctrl-d",
      "ctrl-l",
      "ctrl-r",
    ]) {
      expect(help).toContain(`<code>${key}</code>`);
    }
    expect(help.length).toBeLessThanOrEqual(4_096);
    expect(help).toContain("/key down down enter");
    expect(help).toContain("down down right");
    expect(help).toContain("/model");
    expect(help).toContain("persistent 🪄 Lobby");
    expect(help).toContain("/codex off");
  });

  it("recognizes arrow-only mobile messages without stealing normal prose", () => {
    expect(parseArrowShortcut("up")).toEqual(["up"]);
    expect(parseArrowShortcut("down down, right")).toEqual([
      "down",
      "down",
      "right",
    ]);
    expect(parseArrowShortcut("UP LEFT")).toEqual(["up", "left"]);
    expect(parseArrowShortcut("enter")).toBeNull();
    expect(parseArrowShortcut("go up")).toBeNull();
    expect(parseArrowShortcut("up please")).toBeNull();
  });
});
