import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CodexBridge,
  buildClarityTerminalHtml,
  consumeTranscriptLines,
  isCompactedTranscriptPrefix,
  renderAnsiTerminalSvg,
  splitCompleteTranscriptChunk,
  transcriptCompactionSignal,
} from "../src/vps/codex-bridge";
import {
  assistantNameForModel,
  isPaneIdentity,
  normalizeAssistantName,
  samePaneIdentity,
} from "../src/vps/codex-bridge-protocol";
import { buildCatinaboxCatalog } from "../src/vps/catinabox-catalog";

function line(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}

describe("Codex bridge", () => {
  it("rejects unknown worker profiles before touching tmux", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "catinabox-bridge-"));
    const bridge = new CodexBridge({
      socketPath: path.join(directory, "bridge.sock"),
      databasePath: path.join(directory, "bridge.sqlite"),
    });
    await bridge.listen();
    try {
      await expect(bridge.dispatch({
        op: "new",
        model: "expensive-mystery-model",
      })).resolves.toMatchObject({
        ok: false,
        code: "BAD_PROFILE",
      });
    } finally {
      await bridge.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recognizes exact prompt completion from an existing-session transcript", () => {
    const startedAt = Date.parse("2026-07-26T06:00:00.000Z");
    const input =
      line({
        timestamp: "2026-07-26T06:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello from Telegram" }],
        },
      }) +
      line({
        timestamp: "2026-07-26T06:00:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "exact response <&>" }],
        },
      }) +
      line({
        timestamp: "2026-07-26T06:00:03.000Z",
        type: "event_msg",
        payload: { type: "task_complete" },
      });

    expect(consumeTranscriptLines(input, {
      prompt: "hello from Telegram",
      startedAt,
      promptSeen: false,
      assistantMessage: null,
    })).toMatchObject({
      carry: "",
      promptSeen: true,
      assistantMessage: "exact response <&>",
      complete: true,
    });
  });

  it("keeps an incomplete JSONL record for the next transcript read", () => {
    expect(consumeTranscriptLines('{"timestamp":"partial', {
      prompt: "x",
      startedAt: 0,
      promptSeen: false,
      assistantMessage: null,
    })).toMatchObject({
      carry: '{"timestamp":"partial',
      promptSeen: false,
      complete: false,
    });
  });

  it("advances through an oversized JSONL record instead of pinning the relay", () => {
    const oversizedSlice = Buffer.alloc(2 * 1024 * 1024, 0x61);
    const split = splitCompleteTranscriptChunk(oversizedSlice);

    expect(split.complete.byteLength).toBe(0);
    expect(split.consumedBytes).toBe(oversizedSlice.byteLength);
  });

  it("recognizes the native start and completion signals for context compaction", () => {
    expect(transcriptCompactionSignal({
      type: "compacted",
      payload: { replacement_history: [] },
    })).toBe("started");
    expect(transcriptCompactionSignal({
      type: "event_msg",
      payload: { type: "context_compacted" },
    })).toBe("completed");
    expect(transcriptCompactionSignal({
      type: "event_msg",
      payload: { type: "task_complete" },
    })).toBeNull();
  });

  it("recognizes an oversized compacted record before its newline arrives", () => {
    const prefix = Buffer.from(
      '{"timestamp":"2026-07-26T08:30:00Z","type":"compacted","payload":',
    );
    expect(isCompactedTranscriptPrefix(prefix)).toBe(true);
    expect(isCompactedTranscriptPrefix(
      Buffer.from('{"type":"response_item","payload":'),
    )).toBe(false);
  });

  it("maps only the named model families to Telegram identities", () => {
    expect(assistantNameForModel("gpt-5.6-sol")).toBe("Sol");
    expect(assistantNameForModel("gpt-5.6-luna")).toBe("Luna");
    expect(assistantNameForModel("gpt-5.6-terra")).toBe("Terra");
    expect(assistantNameForModel("gpt-5.6-codex")).toBe("Codex");
    expect(assistantNameForModel("console")).toBe("Codex");
    expect(normalizeAssistantName("Lobby")).toBe("Lobby");
  });

  it("requires the complete tmux server, pane, and process identity", () => {
    const target = { serverPid: 1, paneId: "%4", panePid: 2 };
    expect(isPaneIdentity(target)).toBe(true);
    expect(samePaneIdentity(target, { ...target })).toBe(true);
    expect(samePaneIdentity(target, { ...target, panePid: 3 })).toBe(false);
    expect(isPaneIdentity({ ...target, paneId: "4" })).toBe(false);
  });

  it("exposes only canonical visible session names in the Lobby catalog", () => {
    const worker = {
      serverPid: 1,
      paneId: "%4",
      panePid: 40,
      sessionName: "webterm",
      windowName: "Catinabox Development",
      windowIndex: 0,
      cwd: "/root",
      active: true,
      busy: false,
      codexPid: 400,
      assistantName: "Sol" as const,
      sessionId: "worker-thread",
    };
    const lobby = {
      ...worker,
      paneId: "%7",
      panePid: 70,
      windowName: "🪄 Lobby",
      cwd: "/var/lib/catinabox-bridge/lobby",
      codexPid: 700,
      assistantName: "Lobby" as const,
      sessionId: "lobby-thread",
    };

    const catalog = buildCatinaboxCatalog(
      [worker, lobby],
      [
        {
          id: "worker-thread",
          name: "Catinabox Development",
          updatedAt: "2026-07-26T10:00:00Z",
        },
        {
          id: "older-thread",
          name: "Catinabox",
          updatedAt: "2026-07-25T10:00:00Z",
        },
      ],
      worker,
    );

    expect(catalog.attached).toMatchObject({
      selector: "%4",
      name: "Catinabox Development",
      role: "worker",
    });
    expect(catalog.workers[0]?.name).toBe("Catinabox Development");
    expect(catalog.lobby?.name).toBe("🪄 Lobby");
    expect(catalog.recent).toEqual([
      {
        sessionId: "older-thread",
        name: "Catinabox",
        updatedAt: "2026-07-25T10:00:00Z",
      },
    ]);
    expect(JSON.stringify(catalog)).not.toContain("webterm");
  });

  it("preserves Codex true color and terminal emphasis in screen captures", () => {
    const rendered = renderAnsiTerminalSvg(
      "\u001b[38;2;137;180;250mblue\u001b[1;2m status\u001b[0m\n",
    );

    expect(rendered.svg).toContain('fill="rgb(137,180,250)"');
    expect(rendered.svg).toContain('font-weight="700"');
    expect(rendered.svg).toContain('opacity="0.62"');
    expect(rendered.svg).not.toContain("\u001b");
  });

  it("builds a tall, high-density mobile clarity view", () => {
    const input = Array.from(
      { length: 80 },
      (_, index) => `\u001b[32mterminal row ${index + 1}\u001b[0m`,
    ).join("\n");
    const rendered = buildClarityTerminalHtml(input, "current-codex-chat");

    expect(rendered.outputWidth).toBe(4_128);
    expect(rendered.outputHeight).toBe(4_764);
    expect(rendered.html).toContain("font-weight: 550");
    expect(rendered.html).toContain("current-codex-chat");
    expect(rendered.html).toContain("#3fb950");
  });
});
