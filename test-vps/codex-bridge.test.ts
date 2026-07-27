import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import {
  CodexBridge,
  buildClarityTerminalHtml,
  consumeTranscriptLines,
  discoverCodexWorkspaces,
  fullAccessCodexCommand,
  isInternalCodexPrompt,
  isInternalMaintenancePrompt,
  isCompactedTranscriptPrefix,
  localPromptRelayText,
  managedCodexStartupState,
  renderAnsiTerminalSvg,
  parseCodexUsageFromTranscriptTail,
  reasoningSummaryKey,
  parseCodexContextUsedPercentFromTranscriptTail,
  shellSessionFromToolInput,
  shellSessionFromToolOutput,
  splitCompleteTranscriptChunk,
  transcriptGeneratedImage,
  transcriptGeneratedImageFromLineTail,
  transcriptCompactionSignal,
  transcriptTurnEndSignal,
  transcriptReasoningSummaries,
  workerCodexCommand,
  lobbyCodexCommand,
} from "../src/vps/codex-bridge";
import {
  assistantNameForModel,
  isPaneIdentity,
  normalizeAssistantName,
  samePaneIdentity,
} from "../src/vps/codex-bridge-protocol";
import { buildChatinaboxCatalog } from "../src/vps/chatinabox-catalog";

function line(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}

describe("Codex bridge", () => {
  it("discovers bounded Git workspaces beneath configured roots", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "chatinabox-workspaces-"));
    mkdirSync(path.join(root, "alpha", ".git"), { recursive: true });
    mkdirSync(path.join(root, "group", "beta", ".git"), { recursive: true });
    mkdirSync(path.join(root, ".cache", "hidden", ".git"), { recursive: true });
    try {
      expect(await discoverCodexWorkspaces([root])).toEqual([
        { name: "alpha", path: path.join(root, "alpha") },
        { name: "beta", path: path.join(root, "group", "beta") },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not mirror Codex runtime envelopes as VPS-authored messages", () => {
    expect(isInternalCodexPrompt(
      "# AGENTS.md instructions\n\n<INSTRUCTIONS>private runtime</INSTRUCTIONS>",
    )).toBe(true);
    expect(isInternalCodexPrompt(
      "<environment_context>\n  <cwd>/root</cwd>\n</environment_context>",
    )).toBe(true);
    expect(isInternalCodexPrompt(
      "## Memory\n\nYou have access to a memory folder with prior guidance.",
    )).toBe(true);
    expect(isInternalCodexPrompt(
      "<codex_internal_context source=\"goal\">\nContinue working toward the active thread goal.",
    )).toBe(true);
    expect(isInternalCodexPrompt(
      "Can you explain what the memory message was?",
    )).toBe(false);
  });

  it("recognizes structured memory jobs without matching ordinary discussion", () => {
    expect(isInternalMaintenancePrompt(
      "Memory Writing Agent: Phase 2 (Consolidation)\n\n" +
        "You are a Memory Writing Agent. Consolidate the supplied memories.",
    )).toBe(true);
    expect(isInternalMaintenancePrompt(
      "# Memory Writing Agent: Phase 1\r\n\r\n" +
        "You are a Memory Writing Agent working in a background session.",
    )).toBe(true);
    expect(isInternalMaintenancePrompt(
      "Why did a Memory Writing Agent: Phase 2 message appear?",
    )).toBe(false);
  });

  it("bounds unknown local prompt relays before Telegram sees them", () => {
    const oversized = "x".repeat(17 * 1024);
    expect(localPromptRelayText("normal local prompt")).toBe(
      "normal local prompt",
    );
    expect(localPromptRelayText(oversized)).toBe(
      "[local VPS prompt omitted · 17,408 bytes]",
    );
  });

  it("quarantines a complete memory-maintenance transcript turn", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "chatinabox-bridge-"));
    const databasePath = path.join(directory, "bridge.sqlite");
    const transcriptPath = path.join(directory, "rollout.jsonl");
    const bridge = new CodexBridge({
      socketPath: path.join(directory, "bridge.sock"),
      databasePath,
    });
    await bridge.listen();
    try {
      writeFileSync(
        transcriptPath,
        line({
          timestamp: "2026-07-27T10:00:00.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "maintenance-turn" },
        }) +
          line({
            timestamp: "2026-07-27T10:00:00.100Z",
            type: "event_msg",
            payload: {
              type: "user_message",
              message: "Memory Writing Agent: Phase 2 (Consolidation)\n\n" +
                "You are a Memory Writing Agent. Consolidate memories.",
            },
          }) +
          line({
            timestamp: "2026-07-27T10:00:01.000Z",
            type: "response_item",
            payload: {
              type: "reasoning",
              summary: [{ type: "summary_text", text: "Inspecting memory" }],
            },
          }) +
          line({
            timestamp: "2026-07-27T10:00:02.000Z",
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              content: [{
                type: "output_text",
                text: "Consolidation is complete.",
              }],
            },
          }) +
          line({
            timestamp: "2026-07-27T10:00:03.000Z",
            type: "event_msg",
            payload: { type: "task_complete", turn_id: "maintenance-turn" },
          }),
      );
      const db = new DatabaseSync(databasePath);
      db.prepare(`
        INSERT INTO transcript_bindings (
          server_pid, pane_id, pane_pid, session_id, transcript_path,
          cursor, updated_at
        ) VALUES (?, ?, ?, ?, ?, 0, ?)
      `).run(
        100,
        "%4",
        200,
        "maintenance-session",
        transcriptPath,
        Date.now(),
      );
      db.close();

      await (
        bridge as unknown as {
          mirrorTranscriptsOnce(): Promise<void>;
        }
      ).mirrorTranscriptsOnce();

      await expect(bridge.dispatch({ op: "events", limit: 100 }))
        .resolves.toMatchObject({ ok: true, events: [] });
      const verification = new DatabaseSync(databasePath);
      expect(
        verification.prepare(`
          SELECT completed_at FROM internal_turns
          WHERE session_id = ? AND turn_id = ?
        `).get("maintenance-session", "maintenance-turn"),
      ).toMatchObject({ completed_at: expect.any(Number) });
      verification.close();
    } finally {
      await bridge.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reads the newest trustworthy Codex usage snapshot", () => {
    const contents =
      line({ type: "event_msg", payload: { type: "token_count" } }) +
      line({
        timestamp: "2026-07-26T18:36:29.692Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            primary: {
              used_percent: 38,
              window_minutes: 10080,
              resets_at: 1785611896,
            },
            secondary: null,
            credits: { balance: "5000" },
            plan_type: "pro",
          },
        },
      });

    expect(parseCodexUsageFromTranscriptTail(contents)).toEqual({
      observedAt: Date.parse("2026-07-26T18:36:29.692Z"),
      planType: "pro",
      creditsBalance: "5000",
      limits: [{
        usedPercent: 38,
        windowMinutes: 10080,
        resetsAt: 1785611896,
      }],
    });
  });

  it("ignores a newer Spark-specific limit and keeps account-wide Codex usage", () => {
    const contents =
      line({
        timestamp: "2026-07-27T15:08:45.208Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            limit_id: "codex",
            limit_name: null,
            primary: {
              used_percent: 48,
              window_minutes: 10080,
              resets_at: 1785611896,
            },
            secondary: null,
            credits: { balance: "5000" },
            plan_type: "pro",
          },
        },
      }) +
      line({
        timestamp: "2026-07-27T15:10:00.360Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            limit_id: "codex_bengalfox",
            limit_name: "GPT-5.3-Codex-Spark",
            primary: {
              used_percent: 0,
              window_minutes: 10080,
              resets_at: 1785769793,
            },
            secondary: null,
            credits: { balance: "5000" },
            plan_type: "pro",
          },
        },
      });

    expect(parseCodexUsageFromTranscriptTail(contents)).toEqual({
      observedAt: Date.parse("2026-07-27T15:08:45.208Z"),
      planType: "pro",
      creditsBalance: "5000",
      limits: [{
        usedPercent: 48,
        windowMinutes: 10080,
        resetsAt: 1785611896,
      }],
    });
  });

  it("caches automatic usage reads and lets an explicit refresh bypass them", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "chatinabox-usage-"));
    const databasePath = path.join(directory, "bridge.sqlite");
    const transcriptPath = path.join(directory, "usage.jsonl");
    const bridge = new CodexBridge({
      socketPath: path.join(directory, "bridge.sock"),
      databasePath,
    });
    const usageLine = (usedPercent: number, timestamp: string) => line({
      timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          limit_id: "codex",
          primary: {
            used_percent: usedPercent,
            window_minutes: 10080,
            resets_at: 1785611896,
          },
          secondary: null,
          credits: { balance: "5000" },
          plan_type: "pro",
        },
      },
    });
    try {
      writeFileSync(
        transcriptPath,
        usageLine(20, "2026-07-27T17:00:00.000Z"),
      );
      const db = new DatabaseSync(databasePath);
      db.prepare(`
        INSERT INTO transcript_bindings (
          server_pid, pane_id, pane_pid, session_id, transcript_path,
          cursor, updated_at
        ) VALUES (?, ?, ?, ?, ?, 0, ?)
      `).run(100, "%4", 200, "usage-session", transcriptPath, Date.now());
      db.close();

      const first = await bridge.dispatch({ op: "list" });
      expect(first).toMatchObject({
        ok: true,
        usage: { limits: [{ usedPercent: 20 }] },
      });

      writeFileSync(
        transcriptPath,
        usageLine(45, "2026-07-27T17:01:00.000Z"),
      );
      await expect(bridge.dispatch({ op: "list" })).resolves.toMatchObject({
        ok: true,
        usage: { limits: [{ usedPercent: 20 }] },
      });
      await expect(
        bridge.dispatch({ op: "list", refreshUsage: true }),
      ).resolves.toMatchObject({
        ok: true,
        usage: { limits: [{ usedPercent: 45 }] },
      });
    } finally {
      await bridge.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reads current context occupancy from the latest token count", () => {
    const contents = line({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { total_tokens: 35_754 },
          model_context_window: 258_400,
        },
      },
    });
    expect(parseCodexContextUsedPercentFromTranscriptTail(contents)).toBe(14);
  });

  it("extracts only safe reasoning summaries", () => {
    expect(transcriptReasoningSummaries({
      type: "response_item",
      payload: {
        type: "reasoning",
        summary: [
          { type: "summary_text", text: "**Inspecting queue state**" },
          { type: "other", text: "hidden" },
        ],
        encrypted_content: "private",
      },
    })).toEqual(["**Inspecting queue state**"]);
    expect(transcriptReasoningSummaries({
      type: "response_item",
      payload: {
        type: "reasoning",
        summary: [],
        encrypted_content: "private",
      },
    })).toEqual([]);
  });

  it("deduplicates legacy and safe-summary spellings of the same reasoning", () => {
    expect(reasoningSummaryKey("**Inspecting queue state**")).toBe(
      reasoningSummaryKey("Inspecting queue state..."),
    );
    expect(reasoningSummaryKey("Inspecting queue state")).not.toBe(
      reasoningSummaryKey("Checking shell state"),
    );
  });

  it("pins the Telegram worker experience defaults in every launcher", () => {
    const base = fullAccessCodexCommand();
    expect(base).toContain(`model_reasoning_summary="detailed"`);
    expect(base).toContain(`model_verbosity="medium"`);
    expect(base).toContain(`personality="friendly"`);
    expect(base).toContain(`web_search="live"`);
    expect(base).toContain(`plan_mode_reasoning_effort="high"`);
    expect(base).toContain(`hide_agent_reasoning=false`);
    expect(base).toContain(`show_raw_agent_reasoning=false`);
    expect(base).toContain("--enable hooks");

    const worker = workerCodexCommand({
      model: "sol",
      reasoningEffort: "high",
      fast: false,
    });
    expect(worker).toContain(`service_tier="default"`);
    expect(worker).toContain("--enable fast_mode");
    expect(worker).not.toContain("--disable fast_mode");
    expect(worker).not.toContain("trust_level");
    const managedWorker = workerCodexCommand({
      model: "sol",
      reasoningEffort: "high",
      fast: false,
    }, "/var/lib/chatinabox-bridge/manager");
    expect(managedWorker).toContain(
      `projects."/var/lib/chatinabox-bridge/manager".trust_level="trusted"`,
    );
    expect(lobbyCodexCommand("/tmp/lobby")).toContain(
      `model_reasoning_summary="concise"`,
    );
    expect(lobbyCodexCommand("/tmp/lobby")).toContain(
      `model_verbosity="low"`,
    );
  });

  it("recognizes managed Codex trust gates and real prompts", () => {
    expect(managedCodexStartupState(`
Do you trust the contents of this directory?

› 1. Yes, continue
  2. No, quit

Press enter to continue
    `)).toBe("directory_trust");
    expect(managedCodexStartupState(`
› Run /review on my current changes

Use /skills to list available skills

gpt-5.6-sol high
    `)).toBe("ready");
    expect(managedCodexStartupState("Starting Codex…")).toBe("starting");
  });

  it("rejects unknown worker profiles before touching tmux", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "chatinabox-bridge-"));
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

  it("deduplicates an accepted prompt even after its pane has gone away", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "chatinabox-bridge-"));
    const databasePath = path.join(directory, "bridge.sqlite");
    const bridge = new CodexBridge({
      socketPath: path.join(directory, "bridge.sock"),
      databasePath,
    });
    await bridge.listen();
    try {
      const db = new DatabaseSync(databasePath);
      db.prepare(`
        INSERT INTO accepted_deliveries (
          delivery_id, server_pid, pane_id, pane_pid,
          queued_for_next_turn, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run("tg:42:42:0:100", 100, "%4", 200, 1, Date.now());
      db.close();
      await expect(bridge.dispatch({
        op: "send",
        target: { serverPid: 100, paneId: "%4", panePid: 200 },
        text: "retry after restart",
        deliveryId: "tg:42:42:0:100",
      })).resolves.toEqual({
        ok: true,
        sent: true,
        queuedUntilNextToolCall: true,
      });
      await expect(bridge.dispatch({
        op: "send",
        target: { serverPid: 100, paneId: "%5", panePid: 201 },
        text: "conflicting retry",
        deliveryId: "tg:42:42:0:100",
      })).resolves.toMatchObject({
        ok: false,
        code: "BAD_PROMPT",
      });
    } finally {
      await bridge.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reconciles an already-gone pane as closed from its persisted binding", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "chatinabox-bridge-"));
    const databasePath = path.join(directory, "bridge.sqlite");
    const bridge = new CodexBridge({
      socketPath: path.join(directory, "bridge.sock"),
      databasePath,
      defaultCwd: "/root",
    });
    await bridge.listen();
    try {
      const db = new DatabaseSync(databasePath);
      db.prepare(`
        INSERT INTO transcript_bindings (
          server_pid, pane_id, pane_pid, session_id, transcript_path,
          cursor, updated_at
        ) VALUES (?, ?, ?, ?, ?, 0, ?)
      `).run(
        999_991,
        "%999",
        999_992,
        "saved-thread",
        path.join(directory, "gone.jsonl"),
        Date.now(),
      );
      db.prepare(`
        INSERT INTO pane_profiles (
          server_pid, pane_id, pane_pid, model, reasoning_effort,
          fast, cwd, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        999_991,
        "%999",
        999_992,
        "gpt-5.6-sol",
        "high",
        0,
        "/root/chatinabox",
        Date.now(),
      );
      db.close();

      await expect(bridge.dispatch({
        op: "close",
        target: {
          serverPid: 999_991,
          paneId: "%999",
          panePid: 999_992,
        },
      })).resolves.toEqual({
        ok: true,
        closed: true,
        sessionId: "saved-thread",
        profile: {
          model: "sol",
          reasoningEffort: "high",
          fast: false,
          cwd: "/root/chatinabox",
        },
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

  it("extracts completed generated-image paths from complete and oversized tails", () => {
    const savedPath =
      "/root/.codex/generated_images/thread/call_image_123.png";
    expect(transcriptGeneratedImage({
      type: "event_msg",
      payload: {
        type: "image_generation_end",
        call_id: "call_image_123",
        status: "completed",
        saved_path: savedPath,
      },
    })).toEqual({ callId: "call_image_123", savedPath });
    expect(transcriptGeneratedImageFromLineTail(
      `${"x".repeat(1000)},"saved_path":${JSON.stringify(savedPath)}}}`,
    )).toEqual({ callId: "call_image_123", savedPath });
  });

  it("stages an oversized generated-image event for unprivileged delivery", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "chatinabox-image-"));
    const databasePath = path.join(directory, "bridge.sqlite");
    const transcriptPath = path.join(directory, "rollout.jsonl");
    const codexHome = path.join(directory, "codex-home");
    const generatedDirectory = path.join(
      codexHome,
      "generated_images",
      "thread",
    );
    const sourcePath = path.join(generatedDirectory, "call_image_large.png");
    mkdirSync(generatedDirectory, { recursive: true });
    writeFileSync(
      sourcePath,
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from("image"),
      ]),
    );
    writeFileSync(
      transcriptPath,
      line({
        timestamp: "2026-07-27T10:00:00.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "image-turn" },
      }) +
        line({
          timestamp: "2026-07-27T10:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "image_generation_end",
            call_id: "call_image_large",
            status: "completed",
            result: "a".repeat(2 * 1024 * 1024 + 100),
            saved_path: sourcePath,
          },
        }),
    );
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    const bridge = new CodexBridge({
      socketPath: path.join(directory, "bridge.sock"),
      databasePath,
      sharedDataDirectory: path.join(directory, "shared"),
    });
    await bridge.listen();
    try {
      const db = new DatabaseSync(databasePath);
      db.prepare(`
        INSERT INTO transcript_bindings (
          server_pid, pane_id, pane_pid, session_id, transcript_path,
          cursor, updated_at
        ) VALUES (?, ?, ?, ?, ?, 0, ?)
      `).run(
        100,
        "%4",
        200,
        "image-session",
        transcriptPath,
        Date.now(),
      );
      db.close();
      for (let index = 0; index < 3; index += 1) {
        await (
          bridge as unknown as {
            mirrorTranscriptsOnce(): Promise<void>;
          }
        ).mirrorTranscriptsOnce();
      }
      const response = await bridge.dispatch({ op: "events", limit: 20 });
      expect(response).toMatchObject({
        ok: true,
        events: expect.arrayContaining([
          expect.objectContaining({
            kind: "image_generated",
            sessionId: "image-session",
          }),
        ]),
      });
      if (!response.ok || !("events" in response)) {
        throw new Error("Expected bridge events");
      }
      const imageEvent = response.events.find(
        (event) => event.kind === "image_generated",
      );
      expect(imageEvent).toBeDefined();
      expect(imageEvent && existsSync(imageEvent.message)).toBe(true);
      expect(imageEvent?.message).toContain("generated-images");
    } finally {
      await bridge.close();
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      rmSync(directory, { recursive: true, force: true });
    }
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

  it("recognizes both completed and aborted turn terminal events", () => {
    expect(transcriptTurnEndSignal({
      type: "event_msg",
      payload: { type: "task_complete" },
    })).toBe("completed");
    expect(transcriptTurnEndSignal({
      type: "event_msg",
      payload: { type: "turn_aborted", reason: "interrupted" },
    })).toBe("aborted");
    expect(transcriptTurnEndSignal({
      type: "event_msg",
      payload: { type: "task_started" },
    })).toBeNull();
  });

  it("tracks active unified terminal sessions from tool input and output", () => {
    expect(shellSessionFromToolOutput({
      output: [{
        type: "input_text",
        text: JSON.stringify({
          chunk_id: "abc",
          session_id: 50_030,
          output: "",
        }),
      }],
    })).toBe(50_030);
    expect(shellSessionFromToolInput({
      name: "write_stdin",
      input: JSON.stringify({ session_id: 50_030, chars: "" }),
    })).toBe(50_030);
    expect(shellSessionFromToolOutput({
      output: [{ type: "input_text", text: "Process exited with code 0" }],
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
      windowName: "Chatinabox Development",
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
      cwd: "/var/lib/chatinabox-bridge/lobby",
      codexPid: 700,
      assistantName: "Lobby" as const,
      sessionId: "lobby-thread",
    };

    const catalog = buildChatinaboxCatalog(
      [worker, lobby],
      [
        {
          id: "worker-thread",
          name: "Chatinabox Development",
          updatedAt: "2026-07-26T10:00:00Z",
        },
        {
          id: "older-thread",
          name: "Chatinabox",
          updatedAt: "2026-07-25T10:00:00Z",
        },
      ],
      worker,
    );

    expect(catalog.attached).toMatchObject({
      selector: "%4",
      name: "Chatinabox Development",
      role: "worker",
    });
    expect(catalog.workers[0]?.name).toBe("Chatinabox Development");
    expect(catalog.lobby?.name).toBe("🪄 Lobby");
    expect(catalog.recent).toEqual([
      {
        sessionId: "older-thread",
        name: "Chatinabox",
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
