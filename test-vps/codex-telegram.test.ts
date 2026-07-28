import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  formatAbortedCheckpointRichMarkdown,
  formatAgentReasoningRichMarkdown,
  formatCodexEvent,
  formatGoalEditPrompt,
  formatCodexQueuedUntilToolStatus,
  formatCodexRichMarkdown,
  formatCodexTransientRichHtml,
  formatThinkingSectionRichHtml,
  mergeTransientStatus,
  parseArrowShortcut,
  sanitizeAttachmentFileName,
  selectTelegramMedia,
  selectTelegramVoice,
  visibleCodexGoal,
  voiceTranscriptReceiptHtml,
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
  it("marks an interrupted checkpoint without claiming it finished", () => {
    expect(formatAbortedCheckpointRichMarkdown(
      "==Sol==\n\nPartial result.\n\n<footer>cont.</footer>",
    )).toBe(
      "==Sol==\n\nPartial result.\n\n" +
      "<details><summary>details</summary>\n\n" +
      "`task aborted`\n\n</details>\n\n" +
      "<footer>cont. · aborted</footer>",
    );
  });

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
    const legacy = formatCodexEvent({
      id: 1,
      kind: "assistant_final",
      target: { serverPid: 1, paneId: "%1", panePid: 2 },
      sessionId: "session",
      turnId: "turn",
      assistantName: "Sol",
      message: "Finished.",
      createdAt: 1,
    }, personalProfile, {
      summaries_json: JSON.stringify(["Inspecting the queue state"]),
      omitted_count: 0,
    })[0];
    expect(legacy).toContain("<blockquote><b>show thinking</b>");
    expect(legacy).toContain("<i>Inspecting the queue state</i>");
    expect(legacy).not.toMatch(/<(?:details|summary|mark|p|footer)>/u);
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

  it("selects Telegram voice notes and audio uploads for transcription", () => {
    expect(selectTelegramVoice(message({
      voice: {
        file_id: "voice-file",
        file_unique_id: "voice-unique",
        duration: 12,
        mime_type: "audio/ogg",
        file_size: 48_000,
      },
    }))).toEqual({
      fileId: "voice-file",
      fileName: "voice-note.ogg",
      mimeType: "audio/ogg",
      declaredBytes: 48_000,
    });
    expect(selectTelegramVoice(message({
      audio: {
        file_id: "audio-file",
        file_unique_id: "audio-unique",
        duration: 30,
        mime_type: "audio/mpeg",
        file_name: "../../meeting recap.mp3",
      },
    }))).toEqual({
      fileId: "audio-file",
      fileName: "_meeting_recap.mp3",
      mimeType: "audio/mpeg",
    });
  });

  it("transcribes a Telegram voice note and relays the text as one Codex prompt", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chatinabox-voice-"));
    temporaryRoots.push(root);
    const store = new ChatinaboxStore(path.join(root, "state.sqlite"));
    const pane = {
      serverPid: 100,
      paneId: "%4",
      panePid: 200,
      sessionName: "codex",
      windowName: "voice",
      windowIndex: 0,
      cwd: root,
      active: true,
      busy: false,
      codexPid: 300,
      assistantName: "Sol" as const,
    };
    store.attachCodex(42, 42, pane);

    const telegramBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const href = String(url);
      if (href.endsWith("/getFile")) {
        return new Response(JSON.stringify({
          ok: true,
          result: {
            file_id: "voice-file",
            file_unique_id: "voice-unique",
            file_path: "voice/file_1.oga",
          },
        }), { status: 200 });
      }
      if (href.includes("/file/bot")) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-length": "3" },
        });
      }
      if (href === "https://api.elevenlabs.io/v1/speech-to-text") {
        return new Response(JSON.stringify({
          text: "Please run the verification suite.",
        }), { status: 200 });
      }
      if (href.endsWith("/sendRichMessage")) {
        telegramBodies.push(JSON.parse(String(init?.body)));
      }
      return new Response(JSON.stringify({
        ok: true,
        result: { message_id: 900 },
      }), { status: 200 });
    }));
    const bridge = {
      request: vi.fn(async () => ({
        ok: true,
        queuedUntilNextToolCall: false,
      })),
    };
    const controller = new CodexTelegramController({
      env: {
        TG_BOT_TOKEN: "test-token",
        TG_ALLOWED_USER_IDS: "42",
        DATA_DIR: root,
        CODEX_BRIDGE_SOCKET: path.join(root, "bridge.sock"),
        DEFAULT_CWD: root,
        ELEVENLABS_API_KEY: "scribe-secret",
        SCRIBE_LANGUAGE_CODE: "eng",
        SCRIBE_KEYTERMS: ["Codex"],
      },
      store,
      bridge: bridge as never,
    });

    await expect(controller.routeAttachedVoice(message({
      message_id: 77,
      chat: { id: 42 },
      from: { id: 42 },
      voice: {
        file_id: "voice-file",
        file_unique_id: "voice-unique",
        duration: 3,
        mime_type: "audio/ogg",
        file_size: 3,
      },
    }))).resolves.toBe(true);
    expect(bridge.request).toHaveBeenCalledWith(expect.objectContaining({
      op: "send",
      text: "Please run the verification suite.",
      deliveryId: expect.stringContaining(":77"),
    }));
    expect(telegramBodies).toContainEqual(expect.objectContaining({
      chat_id: 42,
      reply_parameters: expect.objectContaining({ message_id: 77 }),
      rich_message: {
        html: expect.stringContaining(
          "<pre>Please run the verification suite.</pre>",
        ),
      },
    }));
    store.close();
  });

  it("keeps long Scribe receipts complete without truncating the transcript", () => {
    const transcript = `first <line>\n${"x".repeat(6_000)}`;
    const html = voiceTranscriptReceiptHtml(transcript);
    expect(html).toHaveLength(3);
    const visible = html.map((chunk) =>
      chunk.match(/<pre>([\s\S]*)<\/pre>/u)?.[1] ?? ""
    ).join("");
    expect(visible).toBe(
      transcript.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;"),
    );
  });

  it("delivers a generated image only to the originating Telegram topic", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chatinabox-output-"));
    temporaryRoots.push(root);
    const store = new ChatinaboxStore(path.join(root, "state.sqlite"));
    const pane = {
      serverPid: 100,
      paneId: "%4",
      panePid: 200,
      sessionName: "codex",
      windowName: "output",
      windowIndex: 0,
      cwd: "/root",
      active: true,
      busy: true,
      codexPid: 300,
      assistantName: "Sol" as const,
    };
    store.attachCodex(-10042, 42, pane, 26);
    store.attachCodex(-10042, 42, pane, 68);
    store.recordCodexPrompt(-10042, 42, pane, 77, false, 26);
    const generatedDirectory = path.join(root, "generated-images");
    const generatedPath = path.join(
      generatedDirectory,
      "session-call_image.png",
    );
    mkdirSync(generatedDirectory, { recursive: true });
    writeFileSync(
      generatedPath,
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from("image"),
      ]),
    );
    const events = [{
      id: 1,
      kind: "image_generated" as const,
      target: pane,
      sessionId: "session",
      turnId: "turn",
      assistantName: "Sol" as const,
      message: generatedPath,
      turnStartedAt: 1,
      createdAt: Date.now(),
    }];
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
          return { ok: true, acked: true };
        }
        throw new Error(`Unexpected request: ${request.op}`);
      }),
    };
    const photoBodies: FormData[] = [];
    vi.stubGlobal("fetch", vi.fn(async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (String(url).endsWith("/sendPhoto")) {
        photoBodies.push(init?.body as FormData);
      }
      return new Response(JSON.stringify({
        ok: true,
        result: { message_id: 901 },
      }), { status: 200 });
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
      bridge: bridge as never,
    });

    await controller.deliverEventsOnce();
    expect(photoBodies).toHaveLength(1);
    expect(photoBodies[0]?.get("chat_id")).toBe("-10042");
    expect(photoBodies[0]?.get("message_thread_id")).toBe("26");
    expect(JSON.parse(String(photoBodies[0]?.get("reply_parameters"))))
      .toMatchObject({ message_id: 77 });
    expect(acknowledged).toEqual(new Set([1]));
    expect(existsSync(generatedPath)).toBe(false);

    await controller.deliverEventsOnce();
    expect(photoBodies).toHaveLength(1);
    store.close();
  });

  it("creates a linked task topic without replacing the Manager topic", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chatinabox-new-topic-"));
    temporaryRoots.push(root);
    const store = new ChatinaboxStore(path.join(root, "state.sqlite"));
    const manager = {
      serverPid: 100,
      paneId: "%10",
      panePid: 210,
      sessionName: "codex",
      windowName: "🪄 Guide · orchestrator",
      windowIndex: 0,
      cwd: "/var/lib/chatinabox-bridge/manager",
      active: true,
      busy: false,
      codexPid: 310,
      assistantName: "Sol" as const,
      sessionId: "manager-session",
    };
    const worker = {
      ...manager,
      paneId: "%21",
      panePid: 221,
      windowName: "GitHub Token Graph",
      cwd: "/root",
      codexPid: 321,
      sessionId: "worker-session",
    };
    store.registerManagerTopic(-10042, 42, 68);
    store.setManagerTarget(-10042, manager);
    store.attachCodex(-10042, 42, manager, 68);
    const event = {
      id: 1,
      kind: "session_handoff" as const,
      target: manager,
      sessionId: "manager-session",
      turnId: "turn",
      assistantName: "Sol" as const,
      message: JSON.stringify({
        destination: {
          serverPid: worker.serverPid,
          paneId: worker.paneId,
          panePid: worker.panePid,
        },
        kind: "created",
      }),
      createdAt: 1,
    };
    const acknowledged: number[] = [];
    const bridge = {
      request: vi.fn(async (request: { op: string; eventId?: number }) => {
        if (request.op === "events") return { ok: true, events: [event] };
        if (request.op === "list") {
          return {
            ok: true,
            panes: [manager, worker],
            recent: [],
            totalSessions: 2,
            usage: null,
          };
        }
        if (request.op === "ack") {
          acknowledged.push(request.eventId!);
          return { ok: true, acked: true };
        }
        throw new Error(`Unexpected request: ${request.op}`);
      }),
    };
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = url.split("/").pop() ?? "";
      const body = JSON.parse(String(init?.body ?? "{}")) as
        Record<string, unknown>;
      calls.push({ method, body });
      return {
        json: async () => ({
          ok: true,
          result: method === "createForumTopic"
            ? {
                message_thread_id: 77,
                name: worker.windowName,
                icon_color: 1,
              }
            : { message_id: 900 + calls.length },
        }),
      };
    }));
    const controller = new CodexTelegramController({
      env: {
        TG_BOT_TOKEN: "test-token",
        TG_ALLOWED_USER_IDS: "42",
        DATA_DIR: root,
        CODEX_BRIDGE_SOCKET: path.join(root, "bridge.sock"),
        DEFAULT_CWD: "/root",
      },
      store,
      bridge: bridge as never,
    });

    await controller.deliverEventsOnce();

    expect(store.codexAttachment(-10042, 42, 68)?.pane_id).toBe("%10");
    expect(store.codexAttachment(-10042, 42, 77)?.pane_id).toBe("%21");
    expect(calls).toContainEqual({
      method: "createForumTopic",
      body: { chat_id: -10042, name: "GitHub Token Graph" },
    });
    expect(calls.some((call) =>
      call.method === "sendMessage" &&
      call.body.message_thread_id === 68 &&
      JSON.stringify(call.body.reply_markup).includes(
        "https://t.me/c/42/77",
      )
    )).toBe(true);
    expect(acknowledged).toEqual([1]);
    store.close();
  });

  it("navigates to an existing topic without swapping either worker", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chatinabox-navigation-"));
    temporaryRoots.push(root);
    const store = new ChatinaboxStore(path.join(root, "state.sqlite"));
    const source = {
      serverPid: 100,
      paneId: "%4",
      panePid: 200,
      sessionName: "codex",
      windowName: "Review",
      windowIndex: 0,
      cwd: "/root",
      active: true,
      busy: false,
      codexPid: 300,
      assistantName: "Sol" as const,
    };
    const destination = {
      ...source,
      paneId: "%10",
      panePid: 210,
      windowName: "🪄 Guide · orchestrator",
      cwd: "/var/lib/chatinabox-bridge/manager",
      codexPid: 310,
    };
    store.attachCodex(-10042, 42, source, 20);
    store.attachCodex(-10042, 42, destination, 68);
    store.registerManagerTopic(-10042, 42, 68);
    store.setManagerTarget(-10042, destination);
    const event = {
      id: 1,
      kind: "session_handoff" as const,
      target: source,
      sessionId: "source",
      turnId: "turn",
      assistantName: "Sol" as const,
      message: JSON.stringify({
        destination: {
          serverPid: destination.serverPid,
          paneId: destination.paneId,
          panePid: destination.panePid,
        },
        kind: "navigate",
      }),
      createdAt: 1,
    };
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    const bridge = {
      request: vi.fn(async (request: { op: string }) => {
        if (request.op === "events") return { ok: true, events: [event] };
        if (request.op === "list") {
          return {
            ok: true,
            panes: [source, destination],
            recent: [],
            totalSessions: 2,
            usage: null,
          };
        }
        return { ok: true, acked: true };
      }),
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        method: url.split("/").pop() ?? "",
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return {
        json: async () => ({ ok: true, result: { message_id: 901 } }),
      };
    }));
    const controller = new CodexTelegramController({
      env: {
        TG_BOT_TOKEN: "test-token",
        TG_ALLOWED_USER_IDS: "42",
        DATA_DIR: root,
        CODEX_BRIDGE_SOCKET: path.join(root, "bridge.sock"),
        DEFAULT_CWD: "/root",
      },
      store,
      bridge: bridge as never,
    });

    await controller.deliverEventsOnce();

    expect(store.codexAttachment(-10042, 42, 20)?.pane_id).toBe("%4");
    expect(store.codexAttachment(-10042, 42, 68)?.pane_id).toBe("%10");
    expect(calls.some((call) => call.method === "createForumTopic")).toBe(false);
    expect(JSON.stringify(calls.at(-1)?.body.reply_markup))
      .toContain("https://t.me/c/42/68");
    store.close();
  });

  it("keeps an existing topic stable when /attach selects another worker", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chatinabox-command-nav-"));
    temporaryRoots.push(root);
    const store = new ChatinaboxStore(path.join(root, "state.sqlite"));
    const source = {
      serverPid: 100,
      paneId: "%4",
      panePid: 204,
      sessionName: "codex",
      windowName: "Review",
      windowIndex: 0,
      cwd: "/root",
      active: true,
      busy: false,
      codexPid: 304,
      assistantName: "Sol" as const,
    };
    const destination = {
      ...source,
      paneId: "%10",
      panePid: 210,
      windowName: "🪄 Guide · orchestrator",
      cwd: "/var/lib/chatinabox-bridge/manager",
      codexPid: 310,
    };
    store.attachCodex(-10042, 42, source, 20);
    store.attachCodex(-10042, 42, destination, 68);
    const bridge = {
      request: vi.fn(async (request: { op: string }) => {
        if (request.op === "list") {
          return {
            ok: true,
            panes: [source, destination],
            recent: [],
            totalSessions: 2,
            usage: null,
          };
        }
        throw new Error(`Unexpected request: ${request.op}`);
      }),
    };
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        method: url.split("/").pop() ?? "",
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return {
        json: async () => ({ ok: true, result: { message_id: 901 } }),
      };
    }));
    const controller = new CodexTelegramController({
      env: {
        TG_BOT_TOKEN: "test-token",
        TG_ALLOWED_USER_IDS: "42",
        DATA_DIR: root,
        CODEX_BRIDGE_SOCKET: path.join(root, "bridge.sock"),
        DEFAULT_CWD: "/root",
      },
      store,
      bridge: bridge as never,
    });

    await controller.handleCommand(message({
      message_id: 55,
      chat: { id: -10042, type: "supergroup" },
      from: { id: 42 },
      message_thread_id: 20,
      is_topic_message: true,
    }), { name: "attach", argument: "%10" });

    expect(store.codexAttachment(-10042, 42, 20)?.pane_id).toBe("%4");
    expect(store.codexAttachment(-10042, 42, 68)?.pane_id).toBe("%10");
    expect(JSON.stringify(calls.at(-1)?.body.reply_markup))
      .toContain("https://t.me/c/42/68");
    store.close();
  });

  it("starts /codex new in a linked topic without replacing the source", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chatinabox-command-new-"));
    temporaryRoots.push(root);
    const store = new ChatinaboxStore(path.join(root, "state.sqlite"));
    const source = {
      serverPid: 100,
      paneId: "%4",
      panePid: 204,
      sessionName: "codex",
      windowName: "Review",
      windowIndex: 0,
      cwd: "/root",
      active: true,
      busy: false,
      codexPid: 304,
      assistantName: "Sol" as const,
    };
    const worker = {
      ...source,
      paneId: "%22",
      panePid: 222,
      windowName: "Fresh Task",
      codexPid: 322,
    };
    store.attachCodex(-10042, 42, source, 20);
    const bridge = {
      request: vi.fn(async (request: { op: string }) => {
        if (request.op === "new") return { ok: true, pane: worker };
        if (request.op === "list") {
          return {
            ok: true,
            panes: [source, worker],
            recent: [],
            totalSessions: 2,
            usage: null,
          };
        }
        throw new Error(`Unexpected request: ${request.op}`);
      }),
    };
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = url.split("/").pop() ?? "";
      const body = JSON.parse(String(init?.body ?? "{}")) as
        Record<string, unknown>;
      calls.push({ method, body });
      return {
        json: async () => ({
          ok: true,
          result: method === "createForumTopic"
            ? {
                message_thread_id: 77,
                name: worker.windowName,
                icon_color: 1,
              }
            : { message_id: 901 },
        }),
      };
    }));
    const controller = new CodexTelegramController({
      env: {
        TG_BOT_TOKEN: "test-token",
        TG_ALLOWED_USER_IDS: "42",
        DATA_DIR: root,
        CODEX_BRIDGE_SOCKET: path.join(root, "bridge.sock"),
        DEFAULT_CWD: "/root",
      },
      store,
      bridge: bridge as never,
    });

    await controller.handleCommand(message({
      message_id: 56,
      chat: { id: -10042, type: "supergroup" },
      from: { id: 42 },
      message_thread_id: 20,
      is_topic_message: true,
    }), { name: "codex_new", argument: "Fresh Task" });

    expect(store.codexAttachment(-10042, 42, 20)?.pane_id).toBe("%4");
    expect(store.codexAttachment(-10042, 42, 77)?.pane_id).toBe("%22");
    expect(calls.some((call) => call.method === "createForumTopic")).toBe(true);
    store.close();
  });

  it("completes a user-created setup topic in place", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chatinabox-guide-"));
    temporaryRoots.push(root);
    const store = new ChatinaboxStore(path.join(root, "state.sqlite"));
    const guide = {
      serverPid: 100,
      paneId: "%20",
      panePid: 220,
      sessionName: "codex",
      windowName: "orchestrator · setup · Review",
      windowIndex: 0,
      cwd: "/var/lib/chatinabox-bridge/manager",
      active: true,
      busy: false,
      codexPid: 320,
      assistantName: "Sol" as const,
    };
    const worker = {
      ...guide,
      paneId: "%21",
      panePid: 221,
      windowName: "Review",
      cwd: "/root",
      codexPid: 321,
    };
    store.rememberTopic(-10042, 42, 20, "Review", "/root");
    store.registerManagerTopic(-10042, 42, 68);
    store.attachCodex(-10042, 42, guide, 20);
    const event = {
      id: 1,
      kind: "session_handoff" as const,
      target: guide,
      sessionId: "guide",
      turnId: "turn",
      assistantName: "Sol" as const,
      message: JSON.stringify({
        destination: {
          serverPid: worker.serverPid,
          paneId: worker.paneId,
          panePid: worker.panePid,
        },
        kind: "created",
      }),
      createdAt: 1,
    };
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    const bridge = {
      request: vi.fn(async (request: { op: string }) => {
        if (request.op === "events") return { ok: true, events: [event] };
        if (request.op === "list") {
          return {
            ok: true,
            panes: [guide, worker],
            recent: [],
            totalSessions: 2,
            usage: null,
          };
        }
        return { ok: true, acked: true };
      }),
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        method: url.split("/").pop() ?? "",
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return { json: async () => ({ ok: true, result: true }) };
    }));
    const controller = new CodexTelegramController({
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

    await controller.deliverEventsOnce();

    expect(store.codexAttachment(-10042, 42, 20)?.pane_id).toBe("%21");
    expect(calls.some((call) => call.method === "createForumTopic")).toBe(false);
    expect(calls).toContainEqual({
      method: "editForumTopic",
      body: {
        chat_id: -10042,
        message_thread_id: 20,
        name: "Review",
      },
    });
    store.close();
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

  it("starts a clean transient when a new prompt follows an interrupt", () => {
    const snapshot = mergeTransientStatus({
      chat_id: 42,
      owner_user_id: 42,
      server_pid: 100,
      pane_id: "%4",
      pane_pid: 200,
      telegram_message_id: 500,
      status_kind: "state_interrupted",
      tool_calls: 4,
      edited_files: 2,
      explored_things: 3,
      active_shells: 1,
      queued_messages: 0,
      reply_to_message_id: 100,
      started_at: 1_000,
      updated_at: 2_000,
    }, "state_working", undefined, undefined, true, 101, 5_000);
    expect(snapshot).toEqual({
      statusKind: "state_working",
      toolCalls: 0,
      editedFiles: 0,
      exploredThings: 0,
      activeShells: 0,
      queuedMessages: 0,
      replyToMessageId: 101,
      startedAt: 5_000,
    });
  });

  it("confirms an interrupt when the pane is no longer busy", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chatinabox-interrupt-"));
    temporaryRoots.push(root);
    let now = 10_000;
    const store = new ChatinaboxStore(
      path.join(root, "state.sqlite"),
      () => now,
    );
    const pane = {
      serverPid: 100,
      paneId: "%4",
      panePid: 200,
      sessionName: "codex",
      windowName: "interrupt test",
      windowIndex: 0,
      cwd: "/root",
      active: true,
      busy: false,
      codexPid: 300,
      assistantName: "Sol" as const,
      sessionId: "session",
    };
    store.attachCodex(42, 42, pane);
    store.setCodexStatus(42, 42, pane, 700, {
      statusKind: "state_interrupting",
      toolCalls: 1,
      editedFiles: 0,
      exploredThings: 0,
      activeShells: 0,
      queuedMessages: 0,
      replyToMessageId: 100,
      startedAt: 1_000,
    });
    now += 2_000;
    const calls: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return {
        json: async () => ({ ok: true, result: true }),
      };
    }));
    const bridge = {
      request: vi.fn(async () => ({
        ok: true,
        panes: [pane],
        recent: [],
        totalSessions: 1,
        usage: null,
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
      now: () => now,
    });
    await controller.refreshStaleTransientTimersOnce();
    expect(store.codexStatus(42, 42, pane)?.status_kind)
      .toBe("state_interrupted");
    expect(JSON.stringify(calls)).toContain("task interrupted");
    store.close();
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
    expect(richSends).toHaveLength(1);
    expect(JSON.stringify(richSends[0]?.body)).toContain("Paused successfully.");
    expect(store.codexStatus(-10042, 42, pane)).toMatchObject({
      telegram_message_id: 700,
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

    now += 9_000;
    await controller.refreshStaleTransientTimersOnce();
    expect(calls.filter((call) => call.method === "editMessageText"))
      .toHaveLength(1);
    expect(JSON.stringify(calls[0]?.body)).toContain("ran");
    expect(JSON.stringify(calls[0]?.body)).toContain("<b>4</b>");
    store.close();
  });

  it("refreshes a silent working timer every ten seconds without faking activity", async () => {
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

    now += 9_999;
    await controller.refreshStaleTransientTimersOnce();
    expect(calls).toHaveLength(0);

    now += 1;
    await controller.refreshStaleTransientTimersOnce();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("editMessageText");
    expect(JSON.stringify(calls[0]?.body)).toContain("1m 10s");
    expect(JSON.stringify(calls[0]?.body)).not.toContain("since update");
    expect(store.codexStatus(-10042, 42, pane)?.updated_at)
      .toBe(actualUpdatedAt);

    now += 10_000;
    await controller.refreshStaleTransientTimersOnce();
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1]?.body)).toContain("1m 20s");

    now += 20_000;
    await controller.refreshStaleTransientTimersOnce();
    expect(calls).toHaveLength(3);
    expect(JSON.stringify(calls[2]?.body)).toContain("1m 40s");
    store.close();
  });

  it("moves each thinking window from the transient into its text checkpoint", async () => {
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

    now += 10_000;
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
        call.method === "editMessageText" &&
        JSON.stringify(call.body).includes("<footer>cont.</footer>"),
    );
    expect(continuationIndex).toBe(0);
    expect(JSON.stringify(calls[continuationIndex]?.body))
      .toContain("Preparing continuation");
    expect(JSON.stringify(calls[continuationIndex]?.body))
      .toContain("The intermediate result.");
    expect(store.codexThinkingSection(-10088, 42, pane)).toBeNull();

    calls.length = 0;
    addEvent("agent_reasoning", "Preparing final");
    addEvent("assistant_final", "The completed result.");
    await controller.deliverEventsOnce();
    const finalAnswerIndex = calls.findIndex(
      (call) =>
        call.method === "editMessageText" &&
        JSON.stringify(call.body).includes("<footer>fin</footer>"),
    );
    expect(finalAnswerIndex).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(calls[finalAnswerIndex]?.body))
      .toContain("Preparing final");
    expect(calls[finalAnswerIndex]?.body).toMatchObject({ message_id: 1_000 });
    expect(calls.at(-1)?.method).toBe("pinChatMessage");
    store.close();
  });

  it("waits five seconds after responses and carries delayed thinking into the next checkpoint", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chatinabox-response-grace-"));
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
      windowName: "response-grace",
      windowIndex: 0,
      cwd: "/root",
      active: true,
      busy: true,
      codexPid: 300,
      assistantName: "Sol" as const,
      sessionId: "session",
    };
    store.attachCodex(-10091, 42, pane, 10);
    store.setCodexStatus(-10091, 42, pane, 700, {
      statusKind: "state_working",
      toolCalls: 1,
      editedFiles: 0,
      exploredThings: 1,
      activeShells: 0,
      queuedMessages: 0,
      replyToMessageId: 650,
      startedAt: now - 1_000,
    });
    store.appendCodexThinkingSummary(
      -10091,
      42,
      pane,
      "Thinking before the checkpoint",
    );
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
    type EventKind =
      | "state_working"
      | "agent_reasoning"
      | "assistant_progress"
      | "assistant_final";
    const events: Array<{
      id: number;
      kind: EventKind;
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
    });
    const addEvent = (kind: EventKind, message: string) => {
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

    addEvent("assistant_progress", "First checkpoint.");
    await controller.deliverEventsOnce();
    expect(calls.map((call) => call.method)).toEqual(["editMessageText"]);
    expect(JSON.stringify(calls[0]?.body))
      .toContain("Thinking before the checkpoint");
    expect(store.codexStatus(-10091, 42, pane)).toBeNull();
    expect(store.codexThinkingSection(-10091, 42, pane)).toBeNull();

    calls.length = 0;
    now += 1_000;
    addEvent("state_working", "working");
    addEvent("agent_reasoning", "Thinking after the checkpoint");
    await controller.deliverEventsOnce();
    expect(calls).toHaveLength(0);
    expect(store.codexStatus(-10091, 42, pane)).toBeNull();
    expect(store.codexThinkingSection(-10091, 42, pane)?.summaries_json)
      .toContain("Thinking after the checkpoint");

    now += 3_999;
    await controller.flushDeferredTransientStartsOnce();
    expect(calls).toHaveLength(0);

    now += 1;
    await controller.flushDeferredTransientStartsOnce();
    expect(calls.map((call) => call.method)).toEqual(["sendRichMessage"]);
    expect(JSON.stringify(calls[0]?.body))
      .toContain("Thinking after the checkpoint");
    expect(store.codexStatus(-10091, 42, pane)?.telegram_message_id)
      .toBe(1_000);

    calls.length = 0;
    now += 1_000;
    addEvent("agent_reasoning", "Thinking before another checkpoint");
    addEvent("assistant_progress", "Second checkpoint.");
    await controller.deliverEventsOnce();
    expect(calls.map((call) => call.method)).toEqual(["editMessageText"]);
    expect(JSON.stringify(calls[0]?.body))
      .toContain("Thinking before another checkpoint");

    calls.length = 0;
    addEvent("state_working", "working");
    addEvent("agent_reasoning", "Thinking that bypasses the transient");
    await controller.deliverEventsOnce();
    expect(calls).toHaveLength(0);

    now += 4_000;
    addEvent("assistant_final", "Done before the grace period elapsed.");
    await controller.deliverEventsOnce();
    const final = calls.find((call) =>
      call.method === "editMessageText" &&
      JSON.stringify(call.body).includes("Done before the grace period elapsed.")
    );
    expect(JSON.stringify(final?.body))
      .toContain("Thinking that bypasses the transient");
    expect(store.codexThinkingSection(-10091, 42, pane)).toBeNull();

    calls.length = 0;
    now += 1_000;
    await controller.flushDeferredTransientStartsOnce();
    expect(calls).toHaveLength(0);
    expect(store.codexStatus(-10091, 42, pane)).toBeNull();
    store.close();
  });

  it("does not treat an explicit next-turn queue as already read", () => {
    const base = {
      id: 1,
      chat_id: 42,
      owner_user_id: 42,
      message_thread_id: 0,
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

  it("keeps thinking inside the live transient and edits it in place", async () => {
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
    expect(calls.map((call) => call.method)).toEqual(["editMessageText"]);
    expect(calls[0]?.body).toMatchObject({ message_id: 700 });
    expect(JSON.stringify(calls[0]?.body)).toContain("First batch");
    expect(store.codexThinkingSection(-10089, 42, pane)?.telegram_message_id)
      .toBe(700);
    expect(store.codexStatus(-10089, 42, pane)?.telegram_message_id)
      .toBe(700);

    calls.length = 0;
    store.appendCodexThinkingSummary(-10089, 42, pane, "Second batch");
    now += 10_000;
    await controller.deliverEventsOnce();
    expect(calls.map((call) => call.method)).toEqual(["editMessageText"]);
    expect(calls[0]?.body).toMatchObject({ message_id: 700 });
    expect(JSON.stringify(calls[0]?.body)).toContain("Second batch");
    expect(store.codexStatus(-10089, 42, pane)?.telegram_message_id)
      .toBe(700);
    store.close();
  });

  it("drives topic presence from working and delivered-final events", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chatinabox-topic-events-"));
    temporaryRoots.push(root);
    const store = new ChatinaboxStore(path.join(root, "state.sqlite"));
    const pane = {
      serverPid: 100,
      paneId: "%4",
      panePid: 200,
      sessionName: "codex",
      windowName: "review",
      windowIndex: 0,
      cwd: root,
      active: true,
      busy: true,
      codexPid: 300,
      assistantName: "Sol" as const,
      sessionId: "session",
    };
    store.attachCodex(-10092, 42, pane, 11);
    store.recordCodexPrompt(-10092, 42, pane, 650);
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = url.split("/").pop() ?? "";
      const body = JSON.parse(
        String(init?.body ?? "{}"),
      ) as Record<string, unknown>;
      calls.push({ method, body });
      return {
        json: async () => ({
          ok: true,
          result:
            method === "editMessageText" || method === "pinChatMessage"
              ? true
              : { message_id: 1_000 },
        }),
      };
    }));
    const events: Array<{
      id: number;
      kind:
        | "state_working"
        | "state_activity"
        | "agent_reasoning"
        | "assistant_progress"
        | "assistant_final"
        | "turn_aborted";
      target: typeof pane;
      sessionId: string;
      turnId: string;
      assistantName: "Sol";
      message: string;
      createdAt: number;
      turnStartedAt?: number;
    }> = [
      {
        id: 1,
        kind: "state_working" as const,
        target: pane,
        sessionId: "session",
        turnId: "turn",
        assistantName: "Sol" as const,
        message: "working",
        createdAt: 1_000,
      },
      {
        id: 2,
        kind: "assistant_progress" as const,
        target: pane,
        sessionId: "session",
        turnId: "transcript-session",
        assistantName: "Sol" as const,
        message: "Checkpoint.",
        createdAt: 2_000,
      },
    ];
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
    const topicPresence = {
      markWorking: vi.fn(async () => undefined),
      markReady: vi.fn(async () => undefined),
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
      topicPresence,
    });

    await controller.deliverEventsOnce();

    expect(topicPresence.markWorking).toHaveBeenCalledTimes(1);
    expect(topicPresence.markWorking).toHaveBeenCalledWith(
      store.codexAttachment(-10092, 42, 11),
    );
    expect(topicPresence.markReady).not.toHaveBeenCalled();
    expect(store.codexResponseCheckpoint(
      -10092,
      42,
      pane,
      "session",
      "transcript-session",
    )).toMatchObject({ telegram_message_id: 1_000 });

    acknowledged.delete(2);
    calls.length = 0;
    await controller.deliverEventsOnce();
    expect(calls).toHaveLength(0);
    expect(acknowledged.has(2)).toBe(true);

    events.push({
      id: 3,
      kind: "assistant_final" as const,
      target: pane,
      sessionId: "session",
      turnId: "actual-turn",
      assistantName: "Sol" as const,
      message: "Checkpoint.",
      createdAt: 3_000,
    });
    await controller.deliverEventsOnce();

    expect(topicPresence.markReady).toHaveBeenCalledTimes(1);
    expect(topicPresence.markReady).toHaveBeenCalledWith(
      store.codexAttachment(-10092, 42, 11),
    );
    const promoted = calls.findLast(
      (call) =>
        call.method === "editMessageText" &&
        JSON.stringify(call.body).includes("<footer>fin</footer>"),
    );
    expect(promoted?.body).toMatchObject({ message_id: 1_000 });
    expect(store.codexResponseCheckpoint(
      -10092,
      42,
      pane,
      "session",
      "transcript-session",
    )).toBeNull();
    expect(acknowledged).toEqual(new Set([1, 2, 3]));
    expect(store.codexTerminalTurn(
      -10092,
      42,
      11,
      "session",
      "actual-turn",
    )).toMatchObject({
      terminal_kind: "assistant_final",
      telegram_message_id: 1_000,
    });
    expect(store.codexTerminalTurn(
      -10092,
      42,
      11,
      "session",
      "transcript-session",
    )).toMatchObject({ terminal_kind: "assistant_final" });

    calls.length = 0;
    events.push(
      {
        id: 4,
        kind: "agent_reasoning",
        target: pane,
        sessionId: "session",
        turnId: "actual-turn",
        assistantName: "Sol",
        message: "Late thinking",
        createdAt: 3_100,
      },
      {
        id: 5,
        kind: "state_activity",
        target: pane,
        sessionId: "session",
        turnId: "actual-turn",
        assistantName: "Sol",
        message: "1\u001f0\u001f1\u001f0",
        createdAt: 3_200,
      },
      {
        id: 6,
        kind: "assistant_progress",
        target: pane,
        sessionId: "session",
        turnId: "actual-turn",
        assistantName: "Sol",
        message: "Checkpoint.",
        createdAt: 3_300,
      },
    );
    await controller.deliverEventsOnce();
    expect(calls).toHaveLength(0);
    expect(topicPresence.markWorking).toHaveBeenCalledTimes(1);
    expect(store.codexThinkingSection(-10092, 42, pane)).toBeNull();
    expect(store.codexResponseCheckpoint(
      -10092,
      42,
      pane,
      "session",
      "actual-turn",
    )).toBeNull();

    calls.length = 0;
    const secondTurnStartedAt = Date.now() + 1_000;
    events.push({
      id: 7,
      kind: "assistant_final",
      target: pane,
      sessionId: "session",
      turnId: "new-turn",
      assistantName: "Sol",
      message: "Checkpoint.",
      createdAt: secondTurnStartedAt + 1_000,
      turnStartedAt: secondTurnStartedAt,
    });
    await controller.deliverEventsOnce();
    expect(calls.some((call) => call.method === "sendRichMessage")).toBe(true);
    expect(store.codexTerminalTurn(
      -10092,
      42,
      11,
      "session",
      "new-turn",
    )).toMatchObject({ terminal_kind: "assistant_final" });
    acknowledged.delete(7);
    calls.length = 0;
    await controller.deliverEventsOnce();
    expect(calls).toHaveLength(0);
    expect(acknowledged.has(7)).toBe(true);

    store.recordCodexResponseCheckpoint(
      -10092,
      42,
      pane,
      "session",
      "transcript-aborted-turn",
      99,
      2_000,
      "checkpoint-hash",
      "==Sol==\n\nPartial.\n\n<footer>cont.</footer>",
    );
    calls.length = 0;
    events.push({
      id: 8,
      kind: "turn_aborted",
      target: pane,
      sessionId: "session",
      turnId: "aborted-turn",
      assistantName: "Sol",
      message: "interrupted",
      createdAt: 6_000,
    });
    await controller.deliverEventsOnce();
    expect(calls[0]).toMatchObject({
      method: "editMessageText",
      body: { message_id: 2_000 },
    });
    expect(JSON.stringify(calls[0]?.body)).toContain("task aborted");
    expect(JSON.stringify(calls[0]?.body))
      .toContain("<footer>cont. · aborted</footer>");
    expect(calls.some((call) => call.method === "sendRichMessage")).toBe(false);
    expect(topicPresence.markReady).toHaveBeenCalledTimes(3);
    expect(store.codexResponseCheckpoint(
      -10092,
      42,
      pane,
      "session",
      "transcript-aborted-turn",
    )).toMatchObject({
      event_id: 8,
      telegram_message_id: 2_000,
      rendered_markdown: expect.stringContaining("task aborted"),
    });
    expect(store.codexTerminalTurn(
      -10092,
      42,
      11,
      "session",
      "aborted-turn",
    )).toMatchObject({ terminal_kind: "turn_aborted" });
    expect(store.codexTerminalTurn(
      -10092,
      42,
      11,
      "session",
      "transcript-aborted-turn",
    )).toMatchObject({ terminal_kind: "turn_aborted" });
    acknowledged.delete(8);
    calls.length = 0;
    await controller.deliverEventsOnce();
    expect(calls).toHaveLength(0);
    expect(acknowledged.has(8)).toBe(true);
    events.push({
      id: 9,
      kind: "assistant_progress",
      target: pane,
      sessionId: "session",
      turnId: "transcript-aborted-turn",
      assistantName: "Sol",
      message: "Partial.",
      createdAt: 6_100,
    });
    calls.length = 0;
    await controller.deliverEventsOnce();
    expect(calls).toHaveLength(0);
    expect(acknowledged.has(9)).toBe(true);
    store.close();
  });

  it("keeps checkpoint thinking buffered when Telegram delivery fails", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chatinabox-thinking-fail-"));
    temporaryRoots.push(root);
    const store = new ChatinaboxStore(path.join(root, "state.sqlite"));
    const pane = {
      serverPid: 100,
      paneId: "%4",
      panePid: 200,
      sessionName: "codex",
      windowName: "thinking-failure",
      windowIndex: 0,
      cwd: "/root",
      active: true,
      busy: true,
      codexPid: 300,
      assistantName: "Sol" as const,
      sessionId: "session",
    };
    store.attachCodex(-10090, 42, pane, 9);
    store.setCodexStatus(-10090, 42, pane, 700, {
      statusKind: "state_working",
      toolCalls: 1,
      editedFiles: 0,
      exploredThings: 1,
      activeShells: 0,
      queuedMessages: 0,
      replyToMessageId: 650,
      startedAt: Date.now() - 1_000,
    });
    store.appendCodexThinkingSummary(
      -10090,
      42,
      pane,
      "Reasoning that must survive",
    );
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const method = url.split("/").pop() ?? "";
      return {
        json: async () =>
          method === "deleteMessage"
            ? { ok: true, result: true }
            : { ok: false, error_code: 500, description: "temporary failure" },
      };
    }));
    const acknowledged: number[] = [];
    const bridge = {
      request: vi.fn(async (
        request: { op: string; eventId?: number },
      ) => {
        if (request.op === "events") {
          return {
            ok: true,
            events: [{
              id: 1,
              kind: "assistant_final" as const,
              target: pane,
              sessionId: "session",
              turnId: "turn",
              assistantName: "Sol" as const,
              message: "Result",
              createdAt: Date.now(),
            }],
          };
        }
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

    expect(acknowledged).toEqual([]);
    expect(store.codexThinkingSection(-10090, 42, pane)?.summaries_json)
      .toContain("Reasoning that must survive");
    store.close();
  });

  it("coalesces rapid prompts before reanchoring beneath the newest message", async () => {
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
    expect(richSends).toHaveLength(1);
    expect(richSends[0]?.body.reply_parameters).toMatchObject({
      message_id: 100,
    });
    expect(richSends[0]?.body.reply_markup).toMatchObject({
      inline_keyboard: [[{ text: "■ interrupt" }]],
    });
    expect(calls.some((call) => call.method === "deleteMessage")).toBe(false);

    await vi.advanceTimersByTimeAsync(701);
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

    expect(bridge.request).toHaveBeenCalledTimes(1);
    expect(bridge.request).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: "tg:42:42:0:101" }),
    );
    const latestTransient = calls
      .filter((call) =>
        call.method === "editMessageText" ||
        call.method === "sendRichMessage"
      )
      .at(-1);
    expect(JSON.stringify(latestTransient?.body)).toContain(
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
    expect(calls.some((call) => call.method === "sendMessage")).toBe(false);
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
    expect(help).toContain("return to Lobby in private");
    expect(help).toContain("open Manager in a forum");
    expect(help).toContain("/forum setup");
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
