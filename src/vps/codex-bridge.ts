import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  open as openFile,
  readdir,
  realpath,
  stat as statFile,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import puppeteer from "rebrowser-puppeteer-core";
import {
  CHATINABOX_LOBBY_NAME,
  DEFAULT_CHATINABOX_LOBBY_CWD,
  isPaneIdentity,
  isPlainRecord,
  samePaneIdentity,
  assistantNameForModel,
  type CodexBridgeRequest,
  type CodexBridgeResponse,
  type CodexPane,
  type CodexPaneIdentity,
  type CodexRecentSession,
  type CodexWorkspace,
  type CodexUsage,
  type CodexUsageLimit,
  type CodexEvent,
  type CodexEventKind,
  type CodexAssistantName,
} from "./codex-bridge-protocol";
import {
  CodexAppServerGoalClient,
  type CodexGoalStatus as AppServerGoalStatus,
} from "./codex-app-server";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_LOCAL_PROMPT_RELAY_BYTES = 16 * 1024;
const MAX_STOP_BYTES = 512 * 1024;
const MAX_EVENTS = 100;
const TRANSCRIPT_DISCOVERY_TAIL_BYTES = 1024 * 1024;
const MODEL_DISCOVERY_TAIL_BYTES = 8 * 1024 * 1024;
const TRANSCRIPT_DISCOVERY_TIMEOUT_MS = 15_000;
const TRANSCRIPT_COMPLETION_TIMEOUT_MS = 6 * 60 * 60 * 1_000;
const MANAGED_STARTUP_ATTEMPTS = 80;
const MANAGED_STARTUP_INTERVAL_MS = 250;
const TMUX = resolveExecutable("CHATINABOX_TMUX_PATH", [
  "/usr/bin/tmux",
  "/usr/local/bin/tmux",
]);
const PS = resolveExecutable("CHATINABOX_PS_PATH", ["/usr/bin/ps", "/bin/ps"]);
const CODEX = resolveExecutable("CHATINABOX_CODEX_PATH", [
  "/usr/local/bin/codex",
  "/usr/bin/codex",
]);
const CONVERT = resolveExecutable("CHATINABOX_CONVERT_PATH", [
  "/usr/bin/convert",
  "/usr/local/bin/convert",
]);
const CHROME = resolveExecutable("CHATINABOX_CHROME_PATH", [
  "/usr/bin/google-chrome",
  "/opt/google/chrome/chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
]);
const CODEX_HOME =
  process.env.CODEX_HOME?.trim() || path.join(homedir(), ".codex");
const ALLOWED_TMUX_KEYS: Readonly<Record<string, string>> = {
  esc: "Escape",
  enter: "Enter",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  tab: "Tab",
  backtab: "BTab",
  pageup: "PPage",
  pagedown: "NPage",
  home: "Home",
  end: "End",
  backspace: "BSpace",
  space: "Space",
  "ctrl-c": "C-c",
  "ctrl-d": "C-d",
  "ctrl-l": "C-l",
  "ctrl-r": "C-r",
} as const;

function resolveExecutable(
  environmentName: string,
  candidates: readonly string[],
): string {
  const configured = process.env[environmentName]?.trim();
  if (configured) return configured;
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

interface BridgeOptions {
  readonly socketPath: string;
  readonly databasePath: string;
  readonly defaultCwd?: string;
  readonly lobbyCwd?: string;
  readonly managerCwd?: string;
  readonly workspaceRoots?: readonly string[];
}

interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly args: string;
}

interface HookSessionRow {
  readonly server_pid: number;
  readonly pane_id: string;
  readonly pane_pid: number;
  readonly session_id: string;
}

interface TranscriptBindingRow {
  readonly server_pid: number;
  readonly pane_id: string;
  readonly pane_pid: number;
  readonly session_id: string;
  readonly transcript_path: string;
  readonly cursor: number;
  readonly pending_agent: string | null;
  readonly pending_key: string | null;
  readonly pending_at: number | null;
  readonly internal_turn_id: string | null;
}

interface TurnActivity {
  readonly sessionId: string;
  readonly turnId: string;
  toolCalls: number;
  readonly editedFiles: Set<string>;
  exploredThings: number;
  readonly reasoningSummaryKeys: Set<string>;
  readonly activeShells: Set<number>;
  readonly pendingShellCalls: Map<string, number>;
  readonly startedAt: number;
}

interface PaneProfile {
  readonly model: string;
  readonly reasoningEffort: "low" | "medium" | "high" | "xhigh";
  readonly fast: boolean;
  readonly cwd: string;
}

export class CodexBridge {
  private readonly db: DatabaseSync;
  private readonly server: net.Server;
  private mirrorTimer: NodeJS.Timeout | null = null;
  private mirrorRunning = false;
  private closing = false;
  private readonly managedStartupRecoveries =
    new Map<string, Promise<boolean>>();
  private usageCache:
    { readonly value: CodexUsage | null; readonly cachedAt: number } | null =
      null;
  private readonly goalClient = new CodexAppServerGoalClient(CODEX);

  constructor(private readonly options: BridgeOptions) {
    mkdirSync(path.dirname(options.databasePath), {
      recursive: true,
      mode: 0o700,
    });
    this.db = new DatabaseSync(options.databasePath);
    chmodSync(options.databasePath, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS hook_sessions (
        server_pid INTEGER NOT NULL,
        pane_id TEXT NOT NULL,
        pane_pid INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        permission_mode TEXT NOT NULL DEFAULT '',
        cwd TEXT NOT NULL DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1,
        busy INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (server_pid, pane_id, pane_pid)
      );
      CREATE TABLE IF NOT EXISTS stop_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL DEFAULT 'assistant_final',
        server_pid INTEGER NOT NULL,
        pane_id TEXT NOT NULL,
        pane_pid INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        message TEXT NOT NULL,
        turn_started_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transcript_bindings (
        server_pid INTEGER NOT NULL,
        pane_id TEXT NOT NULL,
        pane_pid INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        transcript_path TEXT NOT NULL,
        cursor INTEGER NOT NULL,
        pending_agent TEXT,
        pending_key TEXT,
        pending_at INTEGER,
        internal_turn_id TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (server_pid, pane_id, pane_pid)
      );
      CREATE TABLE IF NOT EXISTS prompt_origins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_pid INTEGER NOT NULL,
        pane_id TEXT NOT NULL,
        pane_pid INTEGER NOT NULL,
        prompt_hash TEXT NOT NULL,
        prompt TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS accepted_deliveries (
        delivery_id TEXT PRIMARY KEY,
        server_pid INTEGER NOT NULL,
        pane_id TEXT NOT NULL,
        pane_pid INTEGER NOT NULL,
        queued_for_next_turn INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transcript_suppressions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_pid INTEGER NOT NULL,
        pane_id TEXT NOT NULL,
        pane_pid INTEGER NOT NULL,
        prompt_hash TEXT NOT NULL,
        prompt TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS internal_turns (
        server_pid INTEGER NOT NULL,
        pane_id TEXT NOT NULL,
        pane_pid INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        PRIMARY KEY (
          server_pid, pane_id, pane_pid, session_id, turn_id
        )
      );
      CREATE TABLE IF NOT EXISTS turn_activity (
        server_pid INTEGER NOT NULL,
        pane_id TEXT NOT NULL,
        pane_pid INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        tool_calls INTEGER NOT NULL DEFAULT 0,
        edited_files TEXT NOT NULL DEFAULT '[]',
        explored_things INTEGER NOT NULL DEFAULT 0,
        reasoning_summary_keys TEXT NOT NULL DEFAULT '[]',
        active_shells TEXT NOT NULL DEFAULT '[]',
        pending_shell_calls TEXT NOT NULL DEFAULT '{}',
        started_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (server_pid, pane_id, pane_pid)
      );
      CREATE TABLE IF NOT EXISTS pane_profiles (
        server_pid INTEGER NOT NULL,
        pane_id TEXT NOT NULL,
        pane_pid INTEGER NOT NULL,
        model TEXT NOT NULL,
        reasoning_effort TEXT NOT NULL,
        fast INTEGER NOT NULL DEFAULT 0,
        cwd TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (server_pid, pane_id, pane_pid)
      );
      CREATE TABLE IF NOT EXISTS pending_image_views (
        server_pid INTEGER NOT NULL,
        pane_id TEXT NOT NULL,
        pane_pid INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        call_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (server_pid, pane_id, pane_pid, call_id)
      );
      CREATE TABLE IF NOT EXISTS pane_assistant_names (
        server_pid INTEGER NOT NULL,
        pane_id TEXT NOT NULL,
        pane_pid INTEGER NOT NULL,
        assistant_name TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (server_pid, pane_id, pane_pid)
      );
      CREATE TABLE IF NOT EXISTS pending_handoffs (
        source_server_pid INTEGER NOT NULL,
        source_pane_id TEXT NOT NULL,
        source_pane_pid INTEGER NOT NULL,
        destination_server_pid INTEGER NOT NULL,
        destination_pane_id TEXT NOT NULL,
        destination_pane_pid INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (
          source_server_pid, source_pane_id, source_pane_pid
        )
      );
    `);
    this.migrateHookSessions();
    this.migrateEvents();
    this.migrateTranscriptBindings();
    this.migrateTurnActivity();
    this.server = net.createServer(
      { allowHalfOpen: true },
      (socket) => this.handleSocket(socket),
    );
  }

  async listen(): Promise<void> {
    mkdirSync(path.dirname(this.options.socketPath), {
      recursive: true,
      mode: 0o770,
    });
    rmSync(this.options.socketPath, { force: true });
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.socketPath, () => {
        this.server.off("error", reject);
        chmodSync(this.options.socketPath, 0o660);
        this.mirrorTimer = setInterval(() => {
          void this.mirrorTranscriptsOnce();
        }, 500);
        this.mirrorTimer.unref();
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.mirrorTimer) clearInterval(this.mirrorTimer);
    this.mirrorTimer = null;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    while (this.mirrorRunning) {
      await delay(25);
    }
    this.db.close();
    rmSync(this.options.socketPath, { force: true });
  }

  async dispatch(request: unknown): Promise<CodexBridgeResponse> {
    if (!isPlainRecord(request) || typeof request.op !== "string") {
      return failure("BAD_REQUEST", "Invalid bridge request.");
    }
    switch (request.op) {
      case "ping":
        return { ok: true, pong: true };
      case "list":
        {
          const savedSessions = this.listSavedSessions();
        return {
          ok: true,
          panes: await this.listCodexPanes(),
          recent: savedSessions.slice(0, 8),
          totalSessions: savedSessions.length,
          usage: await this.latestCodexUsage(),
        };
        }
      case "workspaces":
        return {
          ok: true,
          workspaces: await discoverCodexWorkspaces(
            this.options.workspaceRoots ??
              [this.options.defaultCwd ?? homedir()],
          ),
        };
      case "send":
        return this.sendPrompt(request);
      case "interrupt":
        return this.interrupt(request);
      case "keys":
        return this.sendKeys(request);
      case "screen":
        return this.captureScreen(request);
      case "close":
        return this.closeSession(request);
      case "goals":
        return this.listGoals();
      case "goal_get":
        return this.getGoal(request);
      case "goal_set":
        return this.setGoal(request);
      case "goal_clear":
        return this.clearGoal(request);
      case "new":
        return this.createSession(request);
      case "resume":
        return this.resumeSession(request);
      case "rename":
        return this.renameSession(request);
      case "renameSelf":
        return this.renameSession(request, true);
      case "lobby":
        return this.ensureLobby();
      case "handoff":
        return this.queueHandoff(request);
      case "bind":
        return this.bindSession(request);
      case "events":
        return this.readEvents(request);
      case "ack":
        return this.ackEvent(request);
      case "hook":
        return this.acceptHook(request);
      default:
        return failure("BAD_REQUEST", "Unknown bridge operation.");
    }
  }

  private handleSocket(socket: net.Socket): void {
    socket.setEncoding("utf8");
    let data = "";
    let complete = false;
    socket.on("data", (chunk: string) => {
      if (complete) return;
      data += chunk;
      if (Buffer.byteLength(data) > MAX_REQUEST_BYTES) {
        complete = true;
        socket.end(`${JSON.stringify(failure("TOO_LARGE", "Request too large."))}\n`);
      }
    });
    socket.on("end", () => {
      if (complete) return;
      complete = true;
      void (async () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(data.trim());
        } catch {
          socket.end(`${JSON.stringify(failure("BAD_JSON", "Invalid JSON."))}\n`);
          return;
        }
        try {
          const response = await this.dispatch(parsed);
          socket.end(`${JSON.stringify(response)}\n`);
        } catch (error) {
          console.error(
            "[ChatinaboxBridge] Operation failed:",
            error instanceof Error ? error.message : "unknown error",
          );
          socket.end(
            `${JSON.stringify(failure("INTERNAL", "Bridge operation failed."))}\n`,
          );
        }
      })();
    });
    socket.on("error", () => undefined);
  }

  private async listCodexPanes(): Promise<CodexPane[]> {
    let serverPid: number;
    let paneOutput: string;
    try {
      const [server, panes] = await Promise.all([
        run(TMUX, ["display-message", "-p", "#{pid}"]),
        run(TMUX, [
          "list-panes",
          "-a",
          "-F",
          [
            "#{pane_id}",
            "#{pane_pid}",
            "#{session_name}",
            "#{window_name}",
            "#{window_index}",
            "#{pane_current_path}",
            "#{pane_active}",
          ].join("\u001f"),
        ]),
      ]);
      serverPid = parsePositiveInteger(server.trim());
      paneOutput = panes;
    } catch {
      return [];
    }

    const processes = await readProcesses();
    const children = indexChildren(processes);
    const panes: CodexPane[] = [];
    for (const line of paneOutput.trim().split("\n")) {
      if (!line) continue;
      const fields = line.split("\u001f");
      if (fields.length !== 7) continue;
      const [
        paneId,
        panePidRaw,
        sessionName,
        windowName,
        windowIndexRaw,
        cwd,
        activeRaw,
      ] = fields;
      if (!/^%\d{1,10}$/u.test(paneId)) continue;
      const panePid = parsePositiveInteger(panePidRaw);
      const windowIndex = parseNonNegativeInteger(windowIndexRaw);
      const codexPid = findCodexDescendant(panePid, children);
      if (codexPid === null) continue;
      const session = this.db
        .prepare(`
          SELECT session_id, busy FROM hook_sessions
          WHERE server_pid = ? AND pane_id = ? AND pane_pid = ? AND active = 1
        `)
        .get(serverPid, paneId, panePid) as
          | { session_id: string; busy: number }
          | undefined;
      const transcriptBinding = this.db
        .prepare(`
          SELECT session_id FROM transcript_bindings
          WHERE server_pid = ? AND pane_id = ? AND pane_pid = ?
        `)
        .get(serverPid, paneId, panePid) as
          | { session_id: string }
          | undefined;
      const mirroredBusy = this.db
        .prepare(`
          SELECT 1 FROM turn_activity
          WHERE server_pid = ? AND pane_id = ? AND pane_pid = ?
          LIMIT 1
        `)
        .get(serverPid, paneId, panePid) !== undefined;
      panes.push({
        serverPid,
        paneId,
        panePid,
        sessionName: normalizeLabel(sessionName, 80),
        windowName: normalizeLabel(windowName, 80),
        windowIndex,
        cwd: normalizeCwd(cwd),
        active: activeRaw === "1",
        busy: session?.busy === 1 || mirroredBusy,
        codexPid,
        assistantName: this.assistantNameForTarget({
          serverPid,
          paneId,
          panePid,
        }),
        ...(
          session?.session_id || transcriptBinding?.session_id
            ? {
                sessionId:
                  session?.session_id ?? transcriptBinding!.session_id,
              }
            : {}
        ),
      });
    }
    const sorted = panes.sort(
      (left, right) =>
        left.sessionName.localeCompare(right.sessionName) ||
        left.windowIndex - right.windowIndex ||
        left.paneId.localeCompare(right.paneId),
    );
    for (const pane of sorted) {
      await this.recoverManagedTrustGate(pane);
    }
    return sorted;
  }

  private async recoverManagedTrustGate(pane: CodexPane): Promise<void> {
    if (!this.isManagedCwd(pane.cwd)) return;
    const key = [
      pane.serverPid,
      pane.paneId,
      pane.panePid,
    ].join("\u001f");
    const active = this.managedStartupRecoveries.get(key);
    if (active) {
      await active;
      return;
    }
    const screen = await run(TMUX, [
      "capture-pane",
      "-p",
      "-t",
      pane.paneId,
    ]).catch(() => "");
    if (managedCodexStartupState(screen) !== "directory_trust") return;
    const recovery = this.ensureManagedCodexReady(pane).finally(() => {
      this.managedStartupRecoveries.delete(key);
    });
    this.managedStartupRecoveries.set(key, recovery);
    const ready = await recovery;
    if (!ready) {
      console.error(
        `[ChatinaboxBridge] Managed worker ${pane.paneId} remained blocked ` +
          "after automatic directory-trust recovery.",
      );
    }
  }

  private async requireTarget(value: unknown): Promise<CodexPane | null> {
    if (!isPaneIdentity(value)) return null;
    const panes = await this.listCodexPanes();
    return panes.find((pane) => samePaneIdentity(pane, value)) ?? null;
  }

  private async sendPrompt(
    request: Record<string, unknown>,
  ): Promise<CodexBridgeResponse> {
    if (!isPaneIdentity(request.target)) {
      return failure("STALE_TARGET", "That Codex session is no longer available.");
    }
    const requestedTarget = request.target;
    if (
      typeof request.text !== "string" ||
      request.text.trim() === "" ||
      Buffer.byteLength(request.text) > MAX_PROMPT_BYTES ||
      request.text.includes("\u0000")
    ) {
      return failure("BAD_PROMPT", "Prompt is empty or too large.");
    }
    if (
      request.mode !== undefined &&
      request.mode !== "steer" &&
      request.mode !== "queue"
    ) {
      return failure("BAD_PROMPT", "Prompt delivery mode is invalid.");
    }
    const deliveryId = normalizeDeliveryId(request.deliveryId);
    if (request.deliveryId !== undefined && deliveryId === null) {
      return failure("BAD_PROMPT", "Prompt delivery id is invalid.");
    }
    if (deliveryId) {
      const accepted = this.db.prepare(`
        SELECT server_pid, pane_id, pane_pid, queued_for_next_turn
        FROM accepted_deliveries
        WHERE delivery_id = ?
      `).get(deliveryId) as
        | {
            server_pid: number;
            pane_id: string;
            pane_pid: number;
            queued_for_next_turn: number;
          }
        | undefined;
      if (accepted) {
        if (!samePaneIdentity(requestedTarget, {
          serverPid: accepted.server_pid,
          paneId: accepted.pane_id,
          panePid: accepted.pane_pid,
        })) {
          return failure(
            "BAD_PROMPT",
            "Prompt delivery id was already used for another session.",
          );
        }
        return {
          ok: true,
          sent: true,
          queuedUntilNextToolCall: accepted.queued_for_next_turn === 1,
        };
      }
    }
    const target = await this.requireTarget(requestedTarget);
    if (!target) {
      return failure(
        "STALE_TARGET",
        "That Codex session is no longer available.",
      );
    }
    const queueForNextTurn = request.mode === "queue" && target.busy;
    if (deliveryId) {
      this.db.prepare(`
        INSERT INTO accepted_deliveries (
          delivery_id, server_pid, pane_id, pane_pid,
          queued_for_next_turn, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        deliveryId,
        target.serverPid,
        target.paneId,
        target.panePid,
        queueForNextTurn ? 1 : 0,
        Date.now(),
      );
      this.db.prepare(`
        DELETE FROM accepted_deliveries
        WHERE created_at < ?
      `).run(Date.now() - 7 * 24 * 60 * 60 * 1_000);
    }
    const bufferName = `codex-tg-${randomBytes(8).toString("hex")}`;
    const originId = this.recordPromptOrigin(target, request.text);
    let sent = false;
    try {
      await run(TMUX, ["load-buffer", "-b", bufferName, "-"], request.text);
      await run(TMUX, [
        "paste-buffer",
        "-p",
        "-d",
        "-b",
        bufferName,
        "-t",
        target.paneId,
      ]);
      await run(TMUX, [
        "send-keys",
        "-t",
        target.paneId,
        queueForNextTurn ? "Tab" : "Enter",
      ]);
      sent = true;
      if (!this.hasHookRegistration(target)) {
        void this.watchTranscriptFallback(
          target,
          request.text,
          Date.now(),
        ).catch(() => undefined);
      }
      return {
        ok: true,
        sent: true,
        queuedUntilNextToolCall: queueForNextTurn,
      };
    } finally {
      if (!sent) {
        this.deletePromptOrigin(originId);
        if (deliveryId) {
          this.db.prepare(`
            DELETE FROM accepted_deliveries WHERE delivery_id = ?
          `).run(deliveryId);
        }
      }
      await run(TMUX, ["delete-buffer", "-b", bufferName]).catch(() => undefined);
    }
  }

  private async interrupt(
    request: Record<string, unknown>,
  ): Promise<CodexBridgeResponse> {
    const target = await this.requireTarget(request.target);
    if (!target) return failure("STALE_TARGET", "That Codex session is no longer available.");
    if (!target.busy) {
      return failure(
        "NOT_WORKING",
        "That Codex session is not currently running a task.",
      );
    }
    await run(TMUX, ["send-keys", "-t", target.paneId, "C-c"]);
    return { ok: true, interrupted: true };
  }

  private async sendKeys(
    request: Record<string, unknown>,
  ): Promise<CodexBridgeResponse> {
    const target = await this.requireTarget(request.target);
    if (!target) return failure("STALE_TARGET", "That Codex session is no longer available.");
    if (
      !Array.isArray(request.keys) ||
      request.keys.length < 1 ||
      request.keys.length > 8 ||
      request.keys.some((key) =>
        typeof key !== "string" ||
        ALLOWED_TMUX_KEYS[key.toLowerCase()] === undefined
      )
    ) {
      return failure("BAD_KEYS", "One or more terminal keys are not allowed.");
    }
    const tmuxKeys = request.keys.map(
      (key) => ALLOWED_TMUX_KEYS[String(key).toLowerCase()],
    );
    await run(TMUX, ["send-keys", "-t", target.paneId, ...tmuxKeys]);
    return { ok: true, keysSent: true };
  }

  private async captureScreen(
    request: Record<string, unknown>,
  ): Promise<CodexBridgeResponse> {
    const target = await this.requireTarget(request.target);
    if (!target) return failure("STALE_TARGET", "That Codex session is no longer available.");
    const captured = await run(TMUX, [
      "capture-pane",
      "-p",
      "-e",
      "-S",
      "-80",
      "-t",
      target.paneId,
    ]);
    let png: Buffer;
    let width: number;
    let height: number;
    try {
      const clarity = await renderClarityTerminalPng(
        captured,
        target.windowName || `${target.sessionName}:${target.paneId}`,
      );
      png = clarity.png;
      width = clarity.width;
      height = clarity.height;
    } catch (error) {
      console.error(
        "[ChatinaboxBridge] Clarity renderer failed; using SVG fallback:",
        error instanceof Error ? error.message : "unknown error",
      );
      const rendered = renderAnsiTerminalSvg(captured);
      png = await runBuffer(
        CONVERT,
        ["svg:-", "png:-"],
        Buffer.from(rendered.svg, "utf8"),
        5 * 1024 * 1024,
        15_000,
      );
      width = rendered.width;
      height = rendered.height;
    }
    if (png.byteLength > 4 * 1024 * 1024) {
      return failure("SCREEN_TOO_LARGE", "The terminal image is too large.");
    }
    return {
      ok: true,
      screen: {
        imageBase64: png.toString("base64"),
        width,
        height,
        capturedAt: Date.now(),
      },
    };
  }

  private async createSession(
    request: Record<string, unknown>,
  ): Promise<CodexBridgeResponse> {
    if (
      request.model !== undefined &&
      request.model !== "sol" &&
      request.model !== "luna" &&
      request.model !== "terra"
    ) {
      return failure("BAD_PROFILE", "Worker model must be Sol, Luna, or Terra.");
    }
    if (
      request.reasoningEffort !== undefined &&
      request.reasoningEffort !== "low" &&
      request.reasoningEffort !== "medium" &&
      request.reasoningEffort !== "high" &&
      request.reasoningEffort !== "xhigh"
    ) {
      return failure(
        "BAD_PROFILE",
        "Worker effort must be low, medium, high, or xhigh.",
      );
    }
    if (request.fast !== undefined && typeof request.fast !== "boolean") {
      return failure("BAD_PROFILE", "Worker fast mode must be a boolean.");
    }
    const name = normalizeRequestedName(request.name);
    const cwd = normalizeRequestedCwd(
      request.cwd,
      this.options.defaultCwd ?? homedir(),
    );
    const existing = await this.listCodexPanes();
    const tmuxSession =
      normalizeRequestedTmuxSession(request.tmuxSession) ??
      existing[0]?.sessionName ??
      "codex";
    const model = normalizeWorkerModel(request.model);
    const profile = {
      model,
      reasoningEffort: normalizeWorkerReasoningEffort(request.reasoningEffort),
      fast: request.fast === true,
      cwd,
    };
    const command = workerCodexCommand(
      profile,
      this.isManagedCwd(cwd) ? cwd : undefined,
    );
    const response = await this.startTmuxCodex({
      existing,
      tmuxSession,
      name,
      cwd,
      command,
    });
    if (response.ok && "pane" in response) {
      const assistantName = assistantNameForModel(model);
      this.saveAssistantName(response.pane, assistantName);
      this.savePaneProfile(response.pane, profile);
      return {
        ...response,
        pane: { ...response.pane, assistantName },
      };
    }
    return response;
  }

  private async ensureLobby(): Promise<CodexBridgeResponse> {
    const existing = await this.listCodexPanes();
    const running = existing.find(
      (pane) =>
        pane.assistantName === "Lobby" ||
        pane.windowName === CHATINABOX_LOBBY_NAME,
    );
    if (running) {
      this.saveAssistantName(running, "Lobby");
      return { ok: true, pane: running };
    }

    const lobbyCwd = this.options.lobbyCwd ?? DEFAULT_CHATINABOX_LOBBY_CWD;
    mkdirSync(lobbyCwd, { recursive: true, mode: 0o700 });
    const tmuxSession = existing[0]?.sessionName ?? "codex";
    const previousSessionId = this.latestLobbySessionId();
    let response = await this.startTmuxCodex({
      existing,
      tmuxSession,
      name: CHATINABOX_LOBBY_NAME,
      cwd: lobbyCwd,
      command: previousSessionId
        ? `${lobbyCodexCommand(lobbyCwd)} resume ${previousSessionId}`
        : lobbyCodexCommand(lobbyCwd),
    });
    if (
      previousSessionId &&
      (!response.ok || !("pane" in response))
    ) {
      response = await this.startTmuxCodex({
        existing: await this.listCodexPanes(),
        tmuxSession,
        name: CHATINABOX_LOBBY_NAME,
        cwd: lobbyCwd,
        command: lobbyCodexCommand(lobbyCwd),
      });
    }
    if (response.ok && "pane" in response) {
      this.saveAssistantName(response.pane, "Lobby");
      return { ...response, pane: { ...response.pane, assistantName: "Lobby" } };
    }
    return response;
  }

  private latestLobbySessionId(): string | null {
    const row = this.db.prepare(`
      SELECT h.session_id
      FROM hook_sessions h
      JOIN pane_assistant_names a
        ON a.server_pid = h.server_pid
       AND a.pane_id = h.pane_id
       AND a.pane_pid = h.pane_pid
      WHERE a.assistant_name = 'Lobby'
      ORDER BY h.updated_at DESC
      LIMIT 1
    `).get() as { session_id: string } | undefined;
    return row?.session_id &&
        /^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(row.session_id)
      ? row.session_id
      : null;
  }

  private async resumeSession(
    request: Record<string, unknown>,
  ): Promise<CodexBridgeResponse> {
    if (
      typeof request.sessionId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(request.sessionId)
    ) {
      return failure("BAD_SESSION", "That saved Codex session id is invalid.");
    }
    const recent = this.listSavedSessions();
    const saved = recent.find((session) => session.id === request.sessionId);
    if (!saved) {
      return failure("BAD_SESSION", "That saved Codex session is no longer available.");
    }
    const existing = await this.listCodexPanes();
    const alreadyRunning = existing.find(
      (pane) => pane.sessionId === request.sessionId,
    );
    if (alreadyRunning) return { ok: true, pane: alreadyRunning };
    const name = normalizeRequestedName(request.name ?? saved.name);
    if (
      request.model !== undefined &&
      request.model !== "sol" &&
      request.model !== "luna" &&
      request.model !== "terra"
    ) {
      return failure("BAD_PROFILE", "Worker model must be Sol, Luna, or Terra.");
    }
    if (
      request.reasoningEffort !== undefined &&
      request.reasoningEffort !== "low" &&
      request.reasoningEffort !== "medium" &&
      request.reasoningEffort !== "high" &&
      request.reasoningEffort !== "xhigh"
    ) {
      return failure(
        "BAD_PROFILE",
        "Worker effort must be low, medium, high, or xhigh.",
      );
    }
    if (request.fast !== undefined && typeof request.fast !== "boolean") {
      return failure("BAD_PROFILE", "Worker fast mode must be a boolean.");
    }
    const tmuxSession =
      normalizeRequestedTmuxSession(request.tmuxSession) ??
      existing[0]?.sessionName ??
      "codex";
    const profile = {
      model: normalizeWorkerModel(request.model),
      reasoningEffort: normalizeWorkerReasoningEffort(
        request.reasoningEffort,
      ),
      fast: request.fast === true,
      cwd: normalizeRequestedCwd(
        request.cwd,
        this.options.defaultCwd ?? homedir(),
      ),
    };
    const command =
      `${workerCodexCommand(
        profile,
        this.isManagedCwd(profile.cwd) ? profile.cwd : undefined,
      )} resume ${request.sessionId}`;
    const response = await this.startTmuxCodex({
      existing,
      tmuxSession,
      name,
      cwd: profile.cwd,
      command,
    });
    if (response.ok && "pane" in response) {
      const assistantName = assistantNameForModel(profile.model);
      this.saveAssistantName(response.pane, assistantName);
      this.savePaneProfile(response.pane, profile);
      return {
        ...response,
        pane: { ...response.pane, assistantName },
      };
    }
    return response;
  }

  private async closeSession(
    request: Record<string, unknown>,
  ): Promise<CodexBridgeResponse> {
    const target = await this.requireTarget(request.target);
    if (!target) {
      if (!isPaneIdentity(request.target)) {
        return failure("BAD_TARGET", "Invalid Codex session target.");
      }
      const recovered = this.recoverClosedSession(request.target);
      return recovered ??
        failure("STALE_TARGET", "That Codex session is no longer available.");
    }
    if (target.busy) {
      return failure("SESSION_BUSY", "A working Codex session cannot be closed.");
    }
    const saved = this.paneProfile(target);
    const profile = {
      model: profileModelFamily(saved?.model, target.assistantName),
      reasoningEffort: saved?.reasoningEffort ?? "high",
      fast: saved?.fast ?? false,
      cwd: saved?.cwd ?? target.cwd,
    } as const;
    const sessionId = target.sessionId ?? null;
    await run(TMUX, ["send-keys", "-l", "-t", target.paneId, "/exit"])
      .catch(() => undefined);
    await run(TMUX, ["send-keys", "-t", target.paneId, "Enter"])
      .catch(() => undefined);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await delay(100);
      const panes = await this.listCodexPanes();
      if (!panes.some((pane) => samePaneIdentity(pane, target))) {
        return { ok: true, closed: true, sessionId, profile };
      }
    }
    await run(TMUX, ["kill-pane", "-t", target.paneId]);
    return { ok: true, closed: true, sessionId, profile };
  }

  private async listGoals(): Promise<CodexBridgeResponse> {
    const panes = (await this.listCodexPanes()).filter((pane) => pane.sessionId);
    const observations = await this.goalClient.getGoals(
      panes.map((pane) => ({
        threadId: pane.sessionId!,
        cwd: pane.cwd,
      })),
    );
    return {
      ok: true,
      goals: observations.map((observation, index) => ({
        target: panes[index]!,
        threadId: observation.threadId,
        goal: observation.goal,
        ...(observation.error ? { error: observation.error } : {}),
      })),
    };
  }

  private async getGoal(
    request: Record<string, unknown>,
  ): Promise<CodexBridgeResponse> {
    const target = await this.requireGoalTarget(request.target);
    if (!target.ok) return target.response;
    const [observation] = await this.goalClient.getGoals([target.thread]);
    if (!observation || observation.error) {
      return failure(
        "GOAL_UNAVAILABLE",
        observation?.error ?? "Codex goal state is unavailable.",
      );
    }
    return { ok: true, goal: observation.goal };
  }

  private async setGoal(
    request: Record<string, unknown>,
  ): Promise<CodexBridgeResponse> {
    const target = await this.requireGoalTarget(request.target);
    if (!target.ok) return target.response;
    const objective = request.objective;
    const status = request.status;
    const tokenBudget = request.tokenBudget;
    if (
      objective !== undefined &&
      (typeof objective !== "string" || objective.trim().length === 0)
    ) {
      return failure("BAD_GOAL", "Goal objective must not be empty.");
    }
    if (
      status !== undefined &&
      !isCodexGoalStatus(status)
    ) {
      return failure("BAD_GOAL", "Goal status is invalid.");
    }
    if (
      tokenBudget !== undefined &&
      tokenBudget !== null &&
      (!Number.isSafeInteger(tokenBudget) || Number(tokenBudget) <= 0)
    ) {
      return failure("BAD_GOAL", "Goal token budget must be positive.");
    }
    if (
      objective === undefined &&
      status === undefined &&
      tokenBudget === undefined
    ) {
      return failure("BAD_GOAL", "Goal update is empty.");
    }
    try {
      const goal = await this.goalClient.setGoal(target.thread, {
        ...(typeof objective === "string"
          ? { objective: objective.trim() }
          : {}),
        ...(isCodexGoalStatus(status) ? { status } : {}),
        ...(tokenBudget !== undefined
          ? { tokenBudget: tokenBudget === null ? null : Number(tokenBudget) }
          : {}),
      });
      return { ok: true, goal };
    } catch (error) {
      return failure("GOAL_UNAVAILABLE", errorMessage(error));
    }
  }

  private async clearGoal(
    request: Record<string, unknown>,
  ): Promise<CodexBridgeResponse> {
    const target = await this.requireGoalTarget(request.target);
    if (!target.ok) return target.response;
    try {
      await this.goalClient.clearGoal(target.thread);
      return { ok: true, goalCleared: true };
    } catch (error) {
      return failure("GOAL_UNAVAILABLE", errorMessage(error));
    }
  }

  private async requireGoalTarget(
    value: unknown,
  ): Promise<
    | {
      readonly ok: true;
      readonly thread: { readonly threadId: string; readonly cwd: string };
    }
    | { readonly ok: false; readonly response: CodexBridgeResponse }
  > {
    const pane = await this.requireTarget(value);
    if (!pane) {
      return {
        ok: false,
        response: failure(
          "STALE_TARGET",
          "That Codex session is no longer available.",
        ),
      };
    }
    if (!pane.sessionId) {
      return {
        ok: false,
        response: failure(
          "GOAL_UNAVAILABLE",
          "That Codex thread has not been identified yet.",
        ),
      };
    }
    return {
      ok: true,
      thread: { threadId: pane.sessionId, cwd: pane.cwd },
    };
  }

  private recoverClosedSession(
    target: CodexPaneIdentity,
  ): CodexBridgeResponse | null {
    const binding = this.db.prepare(`
      SELECT session_id
      FROM transcript_bindings
      WHERE server_pid = ? AND pane_id = ? AND pane_pid = ?
    `).get(
      target.serverPid,
      target.paneId,
      target.panePid,
    ) as { session_id: string } | undefined;
    const saved = this.paneProfile(target);
    if (!binding && !saved) return null;
    const assistant = this.assistantNameForTarget(target);
    return {
      ok: true,
      closed: true,
      sessionId: binding?.session_id ?? null,
      profile: {
        model: profileModelFamily(saved?.model, assistant),
        reasoningEffort: saved?.reasoningEffort ?? "high",
        fast: saved?.fast ?? false,
        cwd: saved?.cwd ?? this.options.defaultCwd ?? homedir(),
      },
    };
  }

  private async startTmuxCodex(input: {
    readonly existing: readonly CodexPane[];
    readonly tmuxSession: string;
    readonly name: string;
    readonly cwd: string;
    readonly command: string;
  }): Promise<CodexBridgeResponse> {
    const { existing, tmuxSession, name, cwd, command } = input;

    const sessionExists = await run(TMUX, ["has-session", "-t", tmuxSession])
      .then(() => true)
      .catch(() => false);
    if (sessionExists) {
      await run(TMUX, [
        "new-window",
        "-d",
        "-t",
        `${tmuxSession}:`,
        "-n",
        name,
        "-c",
        cwd,
        command,
      ]);
    } else {
      await run(TMUX, [
        "new-session",
        "-d",
        "-s",
        tmuxSession,
        "-n",
        name,
        "-c",
        cwd,
        command,
      ]);
    }
    const pane = await waitForPane(
      () => this.listCodexPanes(),
      (candidate) =>
        candidate.sessionName === tmuxSession &&
        candidate.windowName === name &&
        !existing.some((old) => samePaneIdentity(old, candidate)),
    );
    if (!pane) {
      return failure("START_FAILED", "Codex session did not become ready.");
    }
    if (
      this.isManagedCwd(cwd) &&
      !await this.ensureManagedCodexReady(pane)
    ) {
      await run(TMUX, ["kill-pane", "-t", pane.paneId])
        .catch(() => undefined);
      return failure(
        "START_BLOCKED",
        "The managed Codex session did not reach a usable prompt.",
      );
    }
    return { ok: true, pane };
  }

  private isManagedCwd(cwd: string): boolean {
    const candidate = path.resolve(cwd);
    return [
      this.options.lobbyCwd ?? DEFAULT_CHATINABOX_LOBBY_CWD,
      this.options.managerCwd,
    ].some(
      (managed) =>
        typeof managed === "string" &&
        candidate === path.resolve(managed),
    );
  }

  private async ensureManagedCodexReady(
    pane: CodexPaneIdentity,
  ): Promise<boolean> {
    let approvedTrust = false;
    for (
      let attempt = 0;
      attempt < MANAGED_STARTUP_ATTEMPTS;
      attempt += 1
    ) {
      const screen = await run(TMUX, [
        "capture-pane",
        "-p",
        "-t",
        pane.paneId,
      ]).catch(() => "");
      const state = managedCodexStartupState(screen);
      if (state === "ready") return true;
      if (state === "directory_trust" && !approvedTrust) {
        await run(TMUX, ["send-keys", "-t", pane.paneId, "Enter"])
          .catch(() => undefined);
        approvedTrust = true;
      }
      await delay(MANAGED_STARTUP_INTERVAL_MS);
    }
    return false;
  }

  private listRecentSessions(): CodexRecentSession[] {
    return this.listSavedSessions().slice(0, 8);
  }

  private listSavedSessions(): CodexRecentSession[] {
    const indexPath =
      process.env.CODEX_SESSION_INDEX ??
      path.join(CODEX_HOME, "session_index.jsonl");
    try {
      const stat = statSync(indexPath);
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return [];
      const contents = readFileSync(indexPath, "utf8");
      const byId = new Map<string, CodexRecentSession>();
      for (const line of contents.split("\n")) {
        if (!line.trim()) continue;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          continue;
        }
        if (!isPlainRecord(value)) continue;
        const id = value.id;
        const name = value.thread_name;
        const updatedAt = value.updated_at;
        if (
          typeof id !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(id) ||
          typeof name !== "string" ||
          typeof updatedAt !== "string" ||
          !Number.isFinite(Date.parse(updatedAt))
        ) {
          continue;
        }
        byId.set(id, {
          id,
          name: normalizeLabel(name, 80) || "Untitled Codex chat",
          updatedAt,
        });
      }
      return [...byId.values()]
        .sort(
          (left, right) =>
            Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
        );
    } catch {
      return [];
    }
  }

  private async latestCodexUsage(): Promise<CodexUsage | null> {
    const now = Date.now();
    if (this.usageCache && now - this.usageCache.cachedAt < 10_000) {
      return this.usageCache.value;
    }
    const rows = this.db.prepare(`
      SELECT transcript_path
      FROM transcript_bindings
      GROUP BY transcript_path
      ORDER BY MAX(updated_at) DESC
      LIMIT 12
    `).all() as unknown as Array<{ transcript_path: string }>;
    const candidates = (
      await Promise.all(rows.map(async ({ transcript_path: transcriptPath }) => {
        const fileStat = await statFile(transcriptPath).catch(() => null);
        return fileStat?.isFile()
          ? { transcriptPath, modifiedAt: fileStat.mtimeMs, size: fileStat.size }
          : null;
      }))
    )
      .filter((candidate) => candidate !== null)
      .sort((left, right) => right.modifiedAt - left.modifiedAt);

    let latest: CodexUsage | null = null;
    for (const candidate of candidates) {
      const bytesToRead = Math.min(candidate.size, 512 * 1024);
      if (bytesToRead <= 0) continue;
      const file = await openFile(candidate.transcriptPath, "r");
      let buffer: Buffer;
      try {
        buffer = Buffer.alloc(bytesToRead);
        const result = await file.read(
          buffer,
          0,
          bytesToRead,
          candidate.size - bytesToRead,
        );
        buffer = buffer.subarray(0, result.bytesRead);
      } finally {
        await file.close();
      }
      const parsed = parseCodexUsageFromTranscriptTail(buffer.toString("utf8"));
      if (parsed && (!latest || parsed.observedAt > latest.observedAt)) {
        latest = parsed;
      }
    }
    this.usageCache = { value: latest, cachedAt: now };
    return latest;
  }

  private async renameSession(
    request: Record<string, unknown>,
    notifyTelegram = false,
  ): Promise<CodexBridgeResponse> {
    const target = await this.requireTarget(request.target);
    if (!target) return failure("STALE_TARGET", "That Codex session is no longer available.");
    const name = normalizeRequestedName(request.name);
    const panes = await this.listCodexPanes();
    const sharesWindow = panes.some(
      (pane) =>
        !samePaneIdentity(pane, target) &&
        pane.sessionName === target.sessionName &&
        pane.windowIndex === target.windowIndex,
    );
    if (sharesWindow) {
      // A window name belongs to every pane in that window. Legacy sessions
      // may share one, so detach only the target pane into its own window
      // before renaming; the Codex process and transcript remain untouched.
      await run(TMUX, [
        "break-pane",
        "-d",
        "-s",
        target.paneId,
        "-n",
        name,
      ]);
    } else {
      await run(TMUX, ["rename-window", "-t", target.paneId, name]);
    }
    const renamed = await this.requireTarget(target);
    if (renamed && notifyTelegram) {
      this.insertMessageEvent(
        "session_renamed",
        target,
        target.sessionId ?? "unknown",
        `rename-${Date.now()}`,
        renamed.windowName,
        `session-renamed:${target.serverPid}:${target.paneId}:` +
          `${target.panePid}:${Date.now()}`,
      );
    }
    return renamed
      ? { ok: true, renamed: true, pane: renamed }
      : failure("STALE_TARGET", "The renamed Codex session disappeared.");
  }

  private async queueHandoff(
    request: Record<string, unknown>,
  ): Promise<CodexBridgeResponse> {
    const source = await this.requireTarget(request.source);
    const destination = await this.requireTarget(request.destination);
    if (!source) {
      return failure("STALE_TARGET", "The source Codex session is no longer available.");
    }
    if (!destination) {
      return failure("STALE_TARGET", "The destination Codex session is no longer available.");
    }
    if (samePaneIdentity(source, destination)) {
      return failure("BAD_HANDOFF", "The destination is already attached.");
    }
    this.db.prepare(`
      INSERT INTO pending_handoffs (
        source_server_pid, source_pane_id, source_pane_pid,
        destination_server_pid, destination_pane_id, destination_pane_pid,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(
        source_server_pid, source_pane_id, source_pane_pid
      ) DO UPDATE SET
        destination_server_pid = excluded.destination_server_pid,
        destination_pane_id = excluded.destination_pane_id,
        destination_pane_pid = excluded.destination_pane_pid,
        created_at = excluded.created_at
    `).run(
      source.serverPid,
      source.paneId,
      source.panePid,
      destination.serverPid,
      destination.paneId,
      destination.panePid,
      Date.now(),
    );
    return { ok: true, handoffQueued: true, destination };
  }

  private async bindSession(
    request: Record<string, unknown>,
  ): Promise<CodexBridgeResponse> {
    const target = await this.requireTarget(request.target);
    if (!target) return failure("STALE_TARGET", "That Codex session is no longer available.");
    if (
      typeof request.sessionId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(request.sessionId) ||
      typeof request.transcriptPath !== "string"
    ) {
      return failure("BAD_SESSION", "Invalid transcript binding.");
    }
    const bound = await this.bindTranscript(
      target,
      request.sessionId,
      request.transcriptPath,
    );
    return bound
      ? { ok: true, accepted: true }
      : failure("BAD_SESSION", "Transcript binding was rejected.");
  }

  private readEvents(
    request: Record<string, unknown>,
  ): CodexBridgeResponse {
    const limit =
      Number.isSafeInteger(request.limit) &&
      Number(request.limit) > 0 &&
      Number(request.limit) <= 20
        ? Number(request.limit)
        : 10;
    const rows = this.db
      .prepare(`SELECT * FROM stop_events ORDER BY id LIMIT ?`)
      .all(limit) as unknown as Array<{
      id: number;
      server_pid: number;
      pane_id: string;
      pane_pid: number;
      kind: CodexEventKind;
      session_id: string;
      turn_id: string;
      assistant_name?: string;
      message: string;
      turn_started_at?: number;
      created_at: number;
    }>;
    const events: CodexEvent[] = rows.map((row) => {
      const target = {
        serverPid: row.server_pid,
        paneId: row.pane_id,
        panePid: row.pane_pid,
      };
      const profile = this.paneProfile(target);
      const contextUsedPercent = row.kind === "assistant_final"
        ? this.contextUsedPercent(target, row.session_id)
        : null;
      return {
        id: row.id,
        kind: isCodexEventKind(row.kind) ? row.kind : "assistant_final",
        target,
        sessionId: row.session_id,
        turnId: row.turn_id,
        assistantName: this.assistantNameForTarget(target),
        message: row.message,
        createdAt: row.created_at,
        ...(row.turn_started_at && row.turn_started_at > 0
          ? { turnStartedAt: row.turn_started_at }
          : {}),
        ...(profile
          ? {
              model: profile.model,
              reasoningEffort: profile.reasoningEffort,
              fast: profile.fast,
              cwd: profile.cwd,
            }
          : {}),
        ...(contextUsedPercent !== null ? { contextUsedPercent } : {}),
      };
    });
    return { ok: true, events };
  }

  private ackEvent(request: Record<string, unknown>): CodexBridgeResponse {
    if (!Number.isSafeInteger(request.eventId) || Number(request.eventId) <= 0) {
      return failure("BAD_EVENT", "Invalid event id.");
    }
    const result = this.db
      .prepare(`DELETE FROM stop_events WHERE id = ?`)
      .run(Number(request.eventId));
    return { ok: true, acked: result.changes > 0 };
  }

  private contextUsedPercent(
    target: CodexPaneIdentity,
    sessionId: string,
  ): number | null {
    const binding = this.db.prepare(`
      SELECT transcript_path FROM transcript_bindings
      WHERE server_pid = ? AND pane_id = ? AND pane_pid = ?
        AND session_id = ?
    `).get(
      target.serverPid,
      target.paneId,
      target.panePid,
      sessionId,
    ) as { transcript_path: string } | undefined;
    if (!binding) return null;
    let descriptor: number | null = null;
    try {
      const fileStat = statSync(binding.transcript_path);
      const bytes = Math.min(fileStat.size, TRANSCRIPT_DISCOVERY_TAIL_BYTES);
      if (bytes <= 0) return null;
      descriptor = openSync(binding.transcript_path, "r");
      const buffer = Buffer.alloc(bytes);
      const read = readSync(
        descriptor,
        buffer,
        0,
        bytes,
        fileStat.size - bytes,
      );
      let contents = buffer.subarray(0, read).toString("utf8");
      if (fileStat.size > bytes) {
        const firstNewline = contents.indexOf("\n");
        contents = firstNewline >= 0 ? contents.slice(firstNewline + 1) : "";
      }
      return parseCodexContextUsedPercentFromTranscriptTail(contents);
    } catch {
      return null;
    } finally {
      if (descriptor !== null) closeSync(descriptor);
    }
  }

  private async acceptHook(
    request: Record<string, unknown>,
  ): Promise<CodexBridgeResponse> {
    if (
      typeof request.paneId !== "string" ||
      !/^%\d{1,10}$/u.test(request.paneId) ||
      !isPlainRecord(request.payload)
    ) {
      return failure("BAD_HOOK", "Invalid hook event.");
    }
    const payload = request.payload;
    const eventName = stringField(payload, "hook_event_name", 64);
    const sessionId = stringField(payload, "session_id", 200);
    if (!eventName || !sessionId) {
      return failure("BAD_HOOK", "Hook event is missing identity.");
    }
    const pane =
      (await this.listCodexPanes()).find(
        (candidate) => candidate.paneId === request.paneId,
      ) ??
      (await this.lookupTmuxPane(request.paneId));
    if (!pane) return failure("STALE_TARGET", "Hook pane is no longer a Codex session.");
    const now = Date.now();
    const permissionMode = stringField(payload, "permission_mode", 80) ?? "";
    const cwd = stringField(payload, "cwd", 4_096) ?? pane.cwd;
    const transcriptPath = stringField(payload, "transcript_path", 8_192);
    if (transcriptPath) {
      await this.bindTranscript(pane, sessionId, transcriptPath);
    }

    if (eventName === "SessionEnd") {
      this.db.prepare(`
        UPDATE hook_sessions SET active = 0, busy = 0, updated_at = ?
        WHERE server_pid = ? AND pane_id = ? AND pane_pid = ?
      `).run(now, pane.serverPid, pane.paneId, pane.panePid);
      return { ok: true, accepted: true };
    }

    this.db.prepare(`
      INSERT INTO hook_sessions (
        server_pid, pane_id, pane_pid, session_id, permission_mode, cwd,
        active, busy, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(server_pid, pane_id, pane_pid) DO UPDATE SET
        session_id = excluded.session_id,
        permission_mode = excluded.permission_mode,
        cwd = excluded.cwd,
        active = 1,
        busy = excluded.busy,
        updated_at = excluded.updated_at
    `).run(
      pane.serverPid,
      pane.paneId,
      pane.panePid,
      sessionId,
      permissionMode,
      cwd,
      eventName === "UserPromptSubmit" ? 1 : 0,
      now,
    );

    if (eventName === "UserPromptSubmit") {
      const turnId = stringField(payload, "turn_id", 200) ?? `hook-${now}`;
      const prompt = stringField(payload, "prompt", MAX_PROMPT_BYTES);
      if (prompt !== null) {
        const telegramOrigin = this.consumePromptOrigin(pane, prompt);
        this.recordTranscriptSuppression(pane, prompt);
        if (isInternalMaintenancePrompt(prompt)) {
          this.recordInternalTurn(pane, sessionId, turnId, now);
          this.deleteTurnActivity(pane);
          this.db.prepare(`
            UPDATE hook_sessions SET busy = 0, updated_at = ?
            WHERE server_pid = ? AND pane_id = ? AND pane_pid = ?
          `).run(now, pane.serverPid, pane.paneId, pane.panePid);
          return { ok: true, accepted: true };
        }
        if (!telegramOrigin && !isInternalCodexPrompt(prompt)) {
          this.insertMessageEvent(
            "user_local",
            pane,
            sessionId,
            turnId,
            localPromptRelayText(prompt),
            `hook-user:${sessionId}:${turnId}`,
          );
        }
      }
      return { ok: true, accepted: true };
    }
    if (eventName !== "Stop") return { ok: true, accepted: true };
    const turnId = stringField(payload, "turn_id", 200);
    const message = stringField(payload, "last_assistant_message", MAX_STOP_BYTES);
    if (!turnId || message === null) {
      return failure("BAD_HOOK", "Stop hook is missing its result.");
    }
    if (this.isInternalTurn(pane, sessionId, turnId)) {
      this.completeInternalTurn(pane, sessionId, turnId, now);
      this.deleteTurnActivity(pane);
      this.db.prepare(`
        UPDATE hook_sessions SET busy = 0, updated_at = ?
        WHERE server_pid = ? AND pane_id = ? AND pane_pid = ?
      `).run(now, pane.serverPid, pane.paneId, pane.panePid);
      return { ok: true, accepted: true };
    }
    const eventKey = `${sessionId}\u001f${turnId}`;
    this.insertMessageEvent(
      "assistant_final",
      pane,
      sessionId,
      turnId,
      message,
      eventKey,
    );
    return { ok: true, accepted: true };
  }

  /**
   * Codex loads hooks when a CLI session starts. Sessions that predate this
   * deployment therefore cannot emit Stop. For only those panes, correlate
   * the exact Telegram prompt with Codex's local rollout and synthesize the
   * same durable stop event after task_complete. The native hook remains the
   * primary path and cancels this watcher as soon as it appears.
   */
  private async watchTranscriptFallback(
    target: CodexPaneIdentity,
    prompt: string,
    startedAt: number,
  ): Promise<void> {
    const discovered = await this.discoverTranscript(
      prompt,
      startedAt,
      target,
    );
    if (!discovered || this.hasHookRegistrationSince(target, startedAt)) return;

    let cursor = discovered.cursor;
    let carry = "";
    let promptSeen = false;
    let assistantMessage: string | null = null;
    const deadline = startedAt + TRANSCRIPT_COMPLETION_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (this.hasHookRegistrationSince(target, startedAt)) return;
      const fileStat = await statFile(discovered.path).catch(() => null);
      if (!fileStat?.isFile()) return;
      if (fileStat.size > cursor) {
        const file = await openFile(discovered.path, "r");
        try {
          const bytesToRead = fileStat.size - cursor;
          const buffer = Buffer.alloc(bytesToRead);
          const result = await file.read(buffer, 0, bytesToRead, cursor);
          cursor += result.bytesRead;
          const parsed = consumeTranscriptLines(
            `${carry}${buffer.subarray(0, result.bytesRead).toString("utf8")}`,
            {
              prompt,
              startedAt,
              promptSeen,
              assistantMessage,
            },
          );
          carry = parsed.carry;
          promptSeen = parsed.promptSeen;
          assistantMessage = parsed.assistantMessage;
          if (parsed.complete && promptSeen && assistantMessage !== null) {
            this.insertFallbackStopEvent(
              target,
              discovered.sessionId,
              assistantMessage,
              startedAt,
            );
            await this.bindTranscript(
              target,
              discovered.sessionId,
              discovered.path,
              cursor,
            );
            return;
          }
        } finally {
          await file.close();
        }
      }
      await delay(500);
    }
  }

  private async discoverTranscript(
    prompt: string,
    startedAt: number,
    target: CodexPaneIdentity,
  ): Promise<{
    readonly path: string;
    readonly sessionId: string;
    readonly cursor: number;
  } | null> {
    const deadline = Date.now() + TRANSCRIPT_DISCOVERY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.hasHookRegistrationSince(target, startedAt)) return null;
      const candidates = await recentTranscriptCandidates(startedAt);
      for (const candidate of candidates) {
        const fileStat = await statFile(candidate.path).catch(() => null);
        if (!fileStat?.isFile()) continue;
        const start = Math.max(
          0,
          fileStat.size - TRANSCRIPT_DISCOVERY_TAIL_BYTES,
        );
        const file = await openFile(candidate.path, "r");
        try {
          const buffer = Buffer.alloc(fileStat.size - start);
          const result = await file.read(
            buffer,
            0,
            buffer.byteLength,
            start,
          );
          const parsed = consumeTranscriptLines(
            buffer.subarray(0, result.bytesRead).toString("utf8"),
            {
              prompt,
              startedAt,
              promptSeen: false,
              assistantMessage: null,
            },
          );
          if (parsed.promptSeen) {
            return {
              path: candidate.path,
              sessionId: candidate.sessionId,
              cursor: start,
            };
          }
        } finally {
          await file.close();
        }
      }
      await delay(250);
    }
    return null;
  }

  private hasHookRegistration(target: CodexPaneIdentity): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM hook_sessions
      WHERE server_pid = ? AND pane_id = ? AND pane_pid = ? AND active = 1
    `).get(target.serverPid, target.paneId, target.panePid);
    return row !== undefined;
  }

  private hasHookRegistrationSince(
    target: CodexPaneIdentity,
    startedAt: number,
  ): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM hook_sessions
      WHERE server_pid = ? AND pane_id = ? AND pane_pid = ?
        AND active = 1 AND updated_at >= ?
    `).get(
      target.serverPid,
      target.paneId,
      target.panePid,
      startedAt - 2_000,
    );
    return row !== undefined;
  }

  private insertFallbackStopEvent(
    target: CodexPaneIdentity,
    sessionId: string,
    message: string,
    startedAt: number,
  ): void {
    const turnId = `transcript-fallback-${startedAt}`;
    this.insertMessageEvent(
      "assistant_final",
      target,
      sessionId,
      turnId,
      message,
      `${sessionId}\u001f${turnId}`,
    );
  }

  private async bindTranscript(
    target: CodexPaneIdentity,
    sessionId: string,
    transcriptPath: string,
    requestedCursor?: number,
  ): Promise<boolean> {
    const transcriptRoot = await realpath(
      process.env.CODEX_TRANSCRIPT_ROOT ?? path.join(CODEX_HOME, "sessions"),
    ).catch(() => null);
    const resolvedPath = await realpath(transcriptPath).catch(() => null);
    if (
      !transcriptRoot ||
      !resolvedPath ||
      !resolvedPath.startsWith(`${transcriptRoot}${path.sep}`) ||
      !resolvedPath.endsWith(".jsonl")
    ) {
      return false;
    }
    const fileStat = await statFile(resolvedPath).catch(() => null);
    if (!fileStat?.isFile()) return false;
    const cursor =
      requestedCursor !== undefined &&
      Number.isSafeInteger(requestedCursor) &&
      requestedCursor >= 0 &&
      requestedCursor <= fileStat.size
        ? requestedCursor
        : fileStat.size;
    this.db.prepare(`
      INSERT INTO transcript_bindings (
        server_pid, pane_id, pane_pid, session_id, transcript_path, cursor,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(server_pid, pane_id, pane_pid) DO UPDATE SET
        session_id = excluded.session_id,
        transcript_path = excluded.transcript_path,
        updated_at = excluded.updated_at
    `).run(
      target.serverPid,
      target.paneId,
      target.panePid,
      sessionId,
      resolvedPath,
      cursor,
      Date.now(),
    );
    return true;
  }

  private recordPromptOrigin(
    target: CodexPaneIdentity,
    prompt: string,
  ): number {
    const result = this.db.prepare(`
      INSERT INTO prompt_origins (
        server_pid, pane_id, pane_pid, prompt_hash, prompt, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      target.serverPid,
      target.paneId,
      target.panePid,
      promptHash(prompt),
      prompt,
      Date.now(),
    );
    this.prunePromptTracking();
    return Number(result.lastInsertRowid);
  }

  private deletePromptOrigin(id: number): void {
    this.db.prepare(`DELETE FROM prompt_origins WHERE id = ?`).run(id);
  }

  private consumePromptOrigin(
    target: CodexPaneIdentity,
    prompt: string,
  ): boolean {
    const row = this.db.prepare(`
      SELECT id FROM prompt_origins
      WHERE server_pid = ? AND pane_id = ? AND pane_pid = ?
        AND prompt_hash = ? AND prompt = ? AND created_at >= ?
      ORDER BY id
      LIMIT 1
    `).get(
      target.serverPid,
      target.paneId,
      target.panePid,
      promptHash(prompt),
      prompt,
      Date.now() - 10 * 60 * 1_000,
    ) as { id: number } | undefined;
    if (!row) return false;
    this.deletePromptOrigin(row.id);
    return true;
  }

  private recordTranscriptSuppression(
    target: CodexPaneIdentity,
    prompt: string,
  ): void {
    this.db.prepare(`
      INSERT INTO transcript_suppressions (
        server_pid, pane_id, pane_pid, prompt_hash, prompt, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      target.serverPid,
      target.paneId,
      target.panePid,
      promptHash(prompt),
      prompt,
      Date.now(),
    );
    this.prunePromptTracking();
  }

  private consumeTranscriptSuppression(
    target: CodexPaneIdentity,
    prompt: string,
  ): boolean {
    const row = this.db.prepare(`
      SELECT id FROM transcript_suppressions
      WHERE server_pid = ? AND pane_id = ? AND pane_pid = ?
        AND prompt_hash = ? AND prompt = ? AND created_at >= ?
      ORDER BY id
      LIMIT 1
    `).get(
      target.serverPid,
      target.paneId,
      target.panePid,
      promptHash(prompt),
      prompt,
      Date.now() - 10 * 60 * 1_000,
    ) as { id: number } | undefined;
    if (!row) return false;
    this.db.prepare(`DELETE FROM transcript_suppressions WHERE id = ?`).run(
      row.id,
    );
    return true;
  }

  private recordInternalTurn(
    target: CodexPaneIdentity,
    sessionId: string,
    turnId: string,
    now = Date.now(),
  ): void {
    this.db.prepare(`
      INSERT INTO internal_turns (
        server_pid, pane_id, pane_pid, session_id, turn_id,
        created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT (
        server_pid, pane_id, pane_pid, session_id, turn_id
      ) DO UPDATE SET
        created_at = excluded.created_at,
        completed_at = NULL
    `).run(
      target.serverPid,
      target.paneId,
      target.panePid,
      sessionId,
      turnId,
      now,
    );
    // A transcript can reveal task_started a few records before its user
    // envelope. Remove any provisional activity event created in that same
    // mirror pass once the turn is identified as internal.
    this.db.prepare(`
      DELETE FROM stop_events
      WHERE server_pid = ? AND pane_id = ? AND pane_pid = ?
        AND session_id = ? AND turn_id = ?
    `).run(
      target.serverPid,
      target.paneId,
      target.panePid,
      sessionId,
      turnId,
    );
    this.db.prepare(`
      DELETE FROM stop_events
      WHERE id = (
        SELECT id FROM stop_events
        WHERE server_pid = ? AND pane_id = ? AND pane_pid = ?
          AND session_id = ? AND kind = 'state_working'
          AND created_at >= ?
        ORDER BY id DESC
        LIMIT 1
      )
    `).run(
      target.serverPid,
      target.paneId,
      target.panePid,
      sessionId,
      Date.now() - 5_000,
    );
    this.prunePromptTracking();
  }

  private isInternalTurn(
    target: CodexPaneIdentity,
    sessionId: string,
    turnId: string,
  ): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM internal_turns
      WHERE server_pid = ? AND pane_id = ? AND pane_pid = ?
        AND session_id = ? AND turn_id = ?
        AND created_at >= ?
    `).get(
      target.serverPid,
      target.paneId,
      target.panePid,
      sessionId,
      turnId,
      Date.now() - 24 * 60 * 60 * 1_000,
    ));
  }

  private completeInternalTurn(
    target: CodexPaneIdentity,
    sessionId: string,
    turnId: string,
    now = Date.now(),
  ): void {
    this.db.prepare(`
      UPDATE internal_turns SET completed_at = ?
      WHERE server_pid = ? AND pane_id = ? AND pane_pid = ?
        AND session_id = ? AND turn_id = ?
    `).run(
      now,
      target.serverPid,
      target.paneId,
      target.panePid,
      sessionId,
      turnId,
    );
  }

  private prunePromptTracking(): void {
    const cutoff = Date.now() - 24 * 60 * 60 * 1_000;
    this.db.prepare(`DELETE FROM prompt_origins WHERE created_at < ?`).run(cutoff);
    this.db
      .prepare(`DELETE FROM transcript_suppressions WHERE created_at < ?`)
      .run(cutoff);
    this.db.prepare(`DELETE FROM internal_turns WHERE created_at < ?`)
      .run(cutoff);
  }

  private insertMessageEvent(
    kind: CodexEventKind,
    target: CodexPaneIdentity,
    sessionId: string,
    turnId: string,
    message: string,
    eventKey: string,
  ): void {
    if (!message || Buffer.byteLength(message) > MAX_STOP_BYTES) return;
    const activity = this.db.prepare(`
      SELECT started_at FROM turn_activity
      WHERE server_pid = ? AND pane_id = ? AND pane_pid = ?
        AND session_id = ? AND turn_id = ?
    `).get(
      target.serverPid,
      target.paneId,
      target.panePid,
      sessionId,
      turnId,
    ) as { started_at: number } | undefined;
    const inserted = this.db.prepare(`
      INSERT OR IGNORE INTO stop_events (
        event_key, kind, server_pid, pane_id, pane_pid, session_id, turn_id,
        message, turn_started_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventKey,
      kind,
      target.serverPid,
      target.paneId,
      target.panePid,
      sessionId,
      turnId,
      message,
      activity?.started_at ?? 0,
      Date.now(),
    );
    if (inserted.changes > 0 && kind === "assistant_final") {
      this.materializePendingHandoff(target, sessionId, turnId);
    }
    this.db.prepare(`
      DELETE FROM stop_events
      WHERE id NOT IN (SELECT id FROM stop_events ORDER BY id DESC LIMIT ?)
    `).run(MAX_EVENTS);
  }

  private materializePendingHandoff(
    source: CodexPaneIdentity,
    sessionId: string,
    turnId: string,
  ): void {
    const row = this.db.prepare(`
      SELECT
        destination_server_pid,
        destination_pane_id,
        destination_pane_pid,
        created_at
      FROM pending_handoffs
      WHERE source_server_pid = ? AND source_pane_id = ? AND source_pane_pid = ?
    `).get(
      source.serverPid,
      source.paneId,
      source.panePid,
    ) as {
      destination_server_pid: number;
      destination_pane_id: string;
      destination_pane_pid: number;
      created_at: number;
    } | undefined;
    if (!row) return;
    if (Date.now() - row.created_at > 30 * 60 * 1_000) {
      this.db.prepare(`
        DELETE FROM pending_handoffs
        WHERE source_server_pid = ? AND source_pane_id = ? AND source_pane_pid = ?
      `).run(source.serverPid, source.paneId, source.panePid);
      return;
    }

    const destination: CodexPaneIdentity = {
      serverPid: row.destination_server_pid,
      paneId: row.destination_pane_id,
      panePid: row.destination_pane_pid,
    };
    this.db.prepare(`
      INSERT OR IGNORE INTO stop_events (
        event_key, kind, server_pid, pane_id, pane_pid, session_id, turn_id,
        message, created_at
      ) VALUES (?, 'session_handoff', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `session-handoff:${sessionId}:${turnId}`,
      source.serverPid,
      source.paneId,
      source.panePid,
      sessionId,
      turnId,
      JSON.stringify(destination),
      Date.now(),
    );
    this.db.prepare(`
      DELETE FROM pending_handoffs
      WHERE source_server_pid = ? AND source_pane_id = ? AND source_pane_pid = ?
    `).run(source.serverPid, source.paneId, source.panePid);
  }

  private readTurnActivity(
    target: CodexPaneIdentity,
    sessionId: string,
  ): TurnActivity | null {
    const row = this.db.prepare(`
      SELECT session_id, turn_id, tool_calls, edited_files,
        explored_things, reasoning_summary_keys, active_shells,
        pending_shell_calls, started_at
      FROM turn_activity
      WHERE server_pid = ? AND pane_id = ? AND pane_pid = ?
    `).get(
      target.serverPid,
      target.paneId,
      target.panePid,
    ) as {
      session_id: string;
      turn_id: string;
      tool_calls: number;
      edited_files: string;
      explored_things: number;
      reasoning_summary_keys: string;
      active_shells: string;
      pending_shell_calls: string;
      started_at: number;
    } | undefined;
    if (!row || row.session_id !== sessionId) return null;
    let editedFiles: string[] = [];
    try {
      const parsed = JSON.parse(row.edited_files) as unknown;
      if (Array.isArray(parsed)) {
        editedFiles = parsed.filter(
          (value): value is string =>
            typeof value === "string" && value.length <= 4_096,
        ).slice(0, 500);
      }
    } catch {
      editedFiles = [];
    }
    const activeShells = parseNumberSet(row.active_shells);
    const pendingShellCalls = parseNumberMap(row.pending_shell_calls);
    return {
      sessionId,
      turnId: row.turn_id,
      toolCalls: Math.max(0, row.tool_calls),
      editedFiles: new Set(editedFiles),
      exploredThings: Math.max(0, row.explored_things),
      reasoningSummaryKeys: parseStringSet(row.reasoning_summary_keys),
      activeShells,
      pendingShellCalls,
      startedAt: row.started_at > 0 ? row.started_at : Date.now(),
    };
  }

  private saveTurnActivity(
    target: CodexPaneIdentity,
    activity: TurnActivity,
  ): void {
    this.db.prepare(`
      INSERT INTO turn_activity (
        server_pid, pane_id, pane_pid, session_id, turn_id,
        tool_calls, edited_files, explored_things, reasoning_summary_keys,
        active_shells, pending_shell_calls, started_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(server_pid, pane_id, pane_pid) DO UPDATE SET
        session_id = excluded.session_id,
        turn_id = excluded.turn_id,
        tool_calls = excluded.tool_calls,
        edited_files = excluded.edited_files,
        explored_things = excluded.explored_things,
        reasoning_summary_keys = excluded.reasoning_summary_keys,
        active_shells = excluded.active_shells,
        pending_shell_calls = excluded.pending_shell_calls,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at
    `).run(
      target.serverPid,
      target.paneId,
      target.panePid,
      activity.sessionId,
      activity.turnId,
      activity.toolCalls,
      JSON.stringify([...activity.editedFiles]),
      activity.exploredThings,
      JSON.stringify([...activity.reasoningSummaryKeys]),
      JSON.stringify([...activity.activeShells]),
      JSON.stringify(Object.fromEntries(activity.pendingShellCalls)),
      activity.startedAt,
      Date.now(),
    );
  }

  private deleteTurnActivity(target: CodexPaneIdentity): void {
    this.db.prepare(`
      DELETE FROM turn_activity
      WHERE server_pid = ? AND pane_id = ? AND pane_pid = ?
    `).run(target.serverPid, target.paneId, target.panePid);
  }

  private async mirrorTranscriptsOnce(): Promise<void> {
    if (this.closing || this.mirrorRunning) return;
    this.mirrorRunning = true;
    try {
      const bindings = this.db.prepare(`
        SELECT * FROM transcript_bindings ORDER BY updated_at
      `).all() as unknown as TranscriptBindingRow[];
      for (const binding of bindings) {
        await this.mirrorBinding(binding);
      }
    } finally {
      this.mirrorRunning = false;
    }
  }

  private async mirrorBinding(binding: TranscriptBindingRow): Promise<void> {
    const target: CodexPaneIdentity = {
      serverPid: binding.server_pid,
      paneId: binding.pane_id,
      panePid: binding.pane_pid,
    };
    const fileStat = await statFile(binding.transcript_path).catch(() => null);
    if (!fileStat?.isFile()) return;
    if (!this.hasAssistantName(target)) {
      const discoveredName = await discoverTranscriptAssistantName(
        binding.transcript_path,
        fileStat.size,
      );
      if (discoveredName) this.saveAssistantName(target, discoveredName);
    }
    let pendingAgent = binding.pending_agent;
    let pendingKey = binding.pending_key;
    let pendingAt = binding.pending_at;
    let internalTurnId = binding.internal_turn_id;
    let activity = this.readTurnActivity(target, binding.session_id);
    let activityDirty = false;
    const flushActivity = (recordOffset: number): void => {
      if (!activity || !activityDirty) return;
      this.saveTurnActivity(target, activity);
      this.insertMessageEvent(
        "state_activity",
        target,
        binding.session_id,
        activity.turnId,
        `${activity.toolCalls}\u001f${activity.editedFiles.size}\u001f` +
          `${activity.exploredThings}\u001f${activity.activeShells.size}`,
        `transcript-activity:${binding.session_id}:${activity.turnId}:` +
          `${activity.toolCalls}:${activity.editedFiles.size}:` +
          `${activity.exploredThings}:${activity.activeShells.size}:` +
          `${recordOffset}`,
      );
      activityDirty = false;
    };
    if (
      pendingAgent &&
      pendingKey &&
      pendingAt &&
      internalTurnId === null &&
      Date.now() - pendingAt >= 1_500
    ) {
      this.insertMessageEvent(
        "assistant_progress",
        target,
        binding.session_id,
        pendingKey,
        pendingAgent,
        pendingKey,
      );
      pendingAgent = null;
      pendingKey = null;
      pendingAt = null;
    }
    if (fileStat.size <= binding.cursor) {
      this.updateBindingCursor(binding, binding.cursor, {
        pendingAgent,
        pendingKey,
        pendingAt,
        internalTurnId,
      });
      return;
    }

    const bytesToRead = Math.min(fileStat.size - binding.cursor, 2 * 1024 * 1024);
    const file = await openFile(binding.transcript_path, "r");
    let buffer: Buffer;
    try {
      buffer = Buffer.alloc(bytesToRead);
      const result = await file.read(buffer, 0, bytesToRead, binding.cursor);
      buffer = buffer.subarray(0, result.bytesRead);
    } finally {
      await file.close();
    }
    const chunk = splitCompleteTranscriptChunk(buffer);
    if (chunk.complete.byteLength === 0) {
      if (internalTurnId === null && isCompactedTranscriptPrefix(buffer)) {
        this.insertMessageEvent(
          "state_compacting",
          target,
          binding.session_id,
          `transcript-compacting:${binding.session_id}:${binding.cursor}`,
          "compacting",
          `transcript-compacting:${binding.session_id}:${binding.cursor}`,
        );
      }
      // A screenshot/tool result can make one JSONL record larger than the
      // bounded mirror chunk. Skip through that oversized record in chunks;
      // the final non-JSON tail is ignored and parsing resumes after its
      // newline instead of pinning the relay cursor forever.
      this.updateBindingCursor(
        binding,
        binding.cursor + chunk.consumedBytes,
        { pendingAgent, pendingKey, pendingAt, internalTurnId },
      );
      return;
    }
    const completeBuffer = chunk.complete;
    const lines = completeBuffer.toString("utf8").split("\n");
    lines.pop();
    let relativeOffset = 0;
    for (const line of lines) {
      const recordOffset = binding.cursor + relativeOffset;
      relativeOffset += Buffer.byteLength(line) + 1;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isPlainRecord(record) || !isPlainRecord(record.payload)) continue;
      const payload = record.payload;
      if (record.type === "turn_context") {
        this.saveAssistantName(
          target,
          assistantNameForModel(payload.model),
        );
      }
      if (
        record.type === "turn_context" ||
        (
          record.type === "event_msg" &&
          payload.type === "thread_settings_applied"
        )
      ) {
        const profile = transcriptPaneProfile(
          record,
          this.paneProfile(target),
        );
        if (profile) this.savePaneProfile(target, profile);
      }
      const compactionSignal = transcriptCompactionSignal(record);
      const turnEndSignal = transcriptTurnEndSignal(record);
      const transcriptPrompt = transcriptUserPrompt(record, payload);
      if (
        transcriptPrompt !== null &&
        isInternalMaintenancePrompt(transcriptPrompt)
      ) {
        const turnId = activity?.turnId ??
          stringField(payload, "turn_id", 200) ??
          "transcript-maintenance";
        internalTurnId = turnId;
        this.recordInternalTurn(
          target,
          binding.session_id,
          turnId,
          transcriptRecordTime(record) ?? Date.now(),
        );
        pendingAgent = null;
        pendingKey = null;
        pendingAt = null;
        this.deleteTurnActivity(target);
        activity = null;
        activityDirty = false;
        continue;
      }
      if (
        record.type === "event_msg" &&
        payload.type === "task_started"
      ) {
        const turnId =
          typeof payload.turn_id === "string" && payload.turn_id.length <= 200
            ? payload.turn_id
            : `transcript-${recordOffset}`;
        if (
          internalTurnId !== null ||
          this.isInternalTurn(target, binding.session_id, turnId)
        ) {
          if (internalTurnId === "transcript-maintenance") {
            this.completeInternalTurn(
              target,
              binding.session_id,
              internalTurnId,
            );
          }
          internalTurnId = turnId;
          this.recordInternalTurn(
            target,
            binding.session_id,
            turnId,
            transcriptRecordTime(record) ?? Date.now(),
          );
        }
      }
      if (internalTurnId !== null) {
        if (turnEndSignal !== null) {
          this.completeInternalTurn(
            target,
            binding.session_id,
            internalTurnId,
          );
          this.db.prepare(`
            UPDATE hook_sessions SET busy = 0, updated_at = ?
            WHERE server_pid = ? AND pane_id = ? AND pane_pid = ?
          `).run(
            Date.now(),
            target.serverPid,
            target.paneId,
            target.panePid,
          );
          internalTurnId = null;
        }
        pendingAgent = null;
        pendingKey = null;
        pendingAt = null;
        this.deleteTurnActivity(target);
        activity = null;
        activityDirty = false;
        continue;
      }
      if (compactionSignal === "started") {
        this.insertMessageEvent(
          "state_compacting",
          target,
          binding.session_id,
          `transcript-compacting:${binding.session_id}:${recordOffset}`,
          "compacting",
          `transcript-compacting:${binding.session_id}:${recordOffset}`,
        );
        continue;
      }
      if (compactionSignal === "completed") {
        this.insertMessageEvent(
          "context_compacted",
          target,
          binding.session_id,
          `transcript-compacted:${binding.session_id}:${recordOffset}`,
          "compacted",
          `transcript-compacted:${binding.session_id}:${recordOffset}`,
        );
        continue;
      }
      if (
        record.type === "event_msg" &&
        payload.type === "task_started"
      ) {
        const turnId =
          typeof payload.turn_id === "string" && payload.turn_id.length <= 200
            ? payload.turn_id
            : `transcript-${recordOffset}`;
        activity = {
          sessionId: binding.session_id,
          turnId,
          toolCalls: 0,
          editedFiles: new Set(),
          exploredThings: 0,
          reasoningSummaryKeys: new Set(),
          activeShells: new Set(),
          pendingShellCalls: new Map(),
          startedAt: transcriptRecordTime(record) ?? Date.now(),
        };
        this.saveTurnActivity(target, activity);
        activityDirty = false;
        this.insertMessageEvent(
          "state_working",
          target,
          binding.session_id,
          `transcript-state:${binding.session_id}:${recordOffset}`,
          "working",
          `transcript-state:${binding.session_id}:${recordOffset}`,
        );
        continue;
      }
      if (
        record.type === "event_msg" &&
        payload.type === "agent_reasoning" &&
        typeof payload.text === "string" &&
        payload.text.trim()
      ) {
        activity ??= {
          sessionId: binding.session_id,
          turnId:
            typeof payload.turn_id === "string"
              ? payload.turn_id.slice(0, 200)
              : `transcript-${binding.session_id}`,
          toolCalls: 0,
          editedFiles: new Set(),
          exploredThings: 0,
          reasoningSummaryKeys: new Set(),
          activeShells: new Set(),
          pendingShellCalls: new Map(),
          startedAt: transcriptRecordTime(record) ?? Date.now(),
        };
        const message = payload.text.trim().slice(0, MAX_STOP_BYTES);
        const summaryKey = reasoningSummaryKey(message);
        if (!activity.reasoningSummaryKeys.has(summaryKey)) {
          activity.reasoningSummaryKeys.add(summaryKey);
          activity.exploredThings += 1;
          activityDirty = true;
          this.insertMessageEvent(
            "agent_reasoning",
            target,
            binding.session_id,
            activity.turnId,
            message,
            `transcript-reasoning:${binding.session_id}:${recordOffset}`,
          );
        }
        continue;
      }
      if (
        record.type === "event_msg" &&
        payload.type === "agent_message" &&
        typeof payload.message === "string"
      ) {
        if (pendingAgent && pendingKey) {
          this.insertMessageEvent(
            "assistant_progress",
            target,
            binding.session_id,
            pendingKey,
            pendingAgent,
            pendingKey,
          );
        }
        pendingAgent = payload.message;
        pendingKey = `transcript-agent:${binding.session_id}:${recordOffset}`;
        pendingAt = Date.now();
        continue;
      }
      if (
        pendingAgent &&
        pendingKey &&
        record.type === "response_item" &&
        (
          payload.type === "reasoning" ||
          payload.type === "function_call" ||
          payload.type === "custom_tool_call"
        )
      ) {
        this.insertMessageEvent(
          "assistant_progress",
          target,
          binding.session_id,
          pendingKey,
          pendingAgent,
          pendingKey,
        );
        pendingAgent = null;
        pendingKey = null;
        pendingAt = null;
      }
      const reasoningSummaries = transcriptReasoningSummaries(record);
      if (reasoningSummaries.length > 0) {
        activity ??= {
          sessionId: binding.session_id,
          turnId: `transcript-${binding.session_id}`,
          toolCalls: 0,
          editedFiles: new Set(),
          exploredThings: 0,
          reasoningSummaryKeys: new Set(),
          activeShells: new Set(),
          pendingShellCalls: new Map(),
          startedAt: transcriptRecordTime(record) ?? Date.now(),
        };
        for (const [index, summary] of reasoningSummaries.entries()) {
          const summaryKey = reasoningSummaryKey(summary);
          if (activity.reasoningSummaryKeys.has(summaryKey)) continue;
          activity.reasoningSummaryKeys.add(summaryKey);
          activity.exploredThings += 1;
          this.insertMessageEvent(
            "agent_reasoning",
            target,
            binding.session_id,
            activity.turnId,
            summary,
            `transcript-reasoning-summary:${binding.session_id}:` +
              `${recordOffset}:${index}`,
          );
        }
        activityDirty = true;
      }
      if (
        record.type === "response_item" &&
        (payload.type === "function_call" || payload.type === "custom_tool_call")
      ) {
        activity ??= {
          sessionId: binding.session_id,
          turnId: `transcript-${binding.session_id}`,
          toolCalls: 0,
          editedFiles: new Set(),
          exploredThings: 0,
          reasoningSummaryKeys: new Set(),
          activeShells: new Set(),
          pendingShellCalls: new Map(),
          startedAt: transcriptRecordTime(record) ?? Date.now(),
        };
        activity.toolCalls += 1;
        activityDirty = true;
        const toolName = typeof payload.name === "string" ? payload.name : "";
        const callId = stringField(payload, "call_id", 300);
        const shellTarget = shellSessionFromToolInput(payload);
        if (callId && shellTarget !== null) {
          activity.pendingShellCalls.set(callId, shellTarget);
          activity.activeShells.add(shellTarget);
        }
        if (toolName === "view_image") {
          if (callId) {
            this.rememberImageViewCall(
              target,
              binding.session_id,
              callId,
            );
          }
        }
        const waiting = toolName === "wait" || toolName === "write_stdin";
        if (waiting) {
          flushActivity(recordOffset);
          this.insertMessageEvent(
            "state_waiting_terminal",
            target,
            binding.session_id,
            `transcript-state:${binding.session_id}:${recordOffset}`,
            "waiting_terminal",
            `transcript-state:${binding.session_id}:${recordOffset}`,
          );
        }
      }
      if (
        record.type === "event_msg" &&
        payload.type === "patch_apply_end" &&
        payload.success === true &&
        isPlainRecord(payload.changes)
      ) {
        activity ??= {
          sessionId: binding.session_id,
          turnId: `transcript-${binding.session_id}`,
          toolCalls: 0,
          editedFiles: new Set(),
          exploredThings: 0,
          reasoningSummaryKeys: new Set(),
          activeShells: new Set(),
          pendingShellCalls: new Map(),
          startedAt: transcriptRecordTime(record) ?? Date.now(),
        };
        for (const filePath of Object.keys(payload.changes)) {
          if (filePath.length <= 4_096 && activity.editedFiles.size < 500) {
            activity.editedFiles.add(filePath);
          }
        }
        activityDirty = true;
      }
      if (
        record.type === "response_item" &&
        (
          payload.type === "function_call_output" ||
          payload.type === "custom_tool_call_output"
        )
      ) {
        if (activity) activityDirty = true;
        const callId = stringField(payload, "call_id", 300);
        if (activity && callId) {
          const targetShell = activity.pendingShellCalls.get(callId);
          const runningShell = shellSessionFromToolOutput(payload);
          if (targetShell !== undefined && runningShell !== targetShell) {
            activity.activeShells.delete(targetShell);
          }
          if (runningShell !== null) {
            activity.activeShells.add(runningShell);
          }
          activity.pendingShellCalls.delete(callId);
        }
        if (
          callId &&
          this.consumeImageViewCall(
            target,
            binding.session_id,
            callId,
          )
        ) {
          this.insertMessageEvent(
            "image_viewed",
            target,
            binding.session_id,
            activity?.turnId ?? callId,
            "viewed_image",
            `transcript-image-viewed:${binding.session_id}:${callId}`,
          );
        }
      }
      if (
        record.type === "response_item" &&
        payload.type === "message" &&
        payload.role === "user"
      ) {
        const prompt = transcriptMessageText(payload);
        if (
          prompt &&
          !isInternalCodexPrompt(prompt) &&
          !this.consumeTranscriptSuppression(target, prompt) &&
          !this.consumePromptOrigin(target, prompt)
        ) {
          const eventKey =
            `transcript-user:${binding.session_id}:${recordOffset}`;
          this.insertMessageEvent(
            "user_local",
            target,
            binding.session_id,
            eventKey,
            localPromptRelayText(prompt),
            eventKey,
          );
        }
      }
      if (
        turnEndSignal === "aborted"
      ) {
        const abortedTurnId =
          typeof payload.turn_id === "string" && payload.turn_id.length <= 200
            ? payload.turn_id
            : activity?.turnId ?? `transcript-${recordOffset}`;
        const reason = typeof payload.reason === "string"
          ? payload.reason.slice(0, 160)
          : "aborted";
        pendingAgent = null;
        pendingKey = null;
        pendingAt = null;
        this.deleteTurnActivity(target);
        activity = null;
        activityDirty = false;
        this.db.prepare(`
          UPDATE hook_sessions SET busy = 0, updated_at = ?
          WHERE server_pid = ? AND pane_id = ? AND pane_pid = ?
        `).run(
          Date.now(),
          target.serverPid,
          target.paneId,
          target.panePid,
        );
        this.insertMessageEvent(
          "turn_aborted",
          target,
          binding.session_id,
          abortedTurnId,
          reason,
          `transcript-aborted:${binding.session_id}:${recordOffset}`,
        );
        continue;
      }
      if (
        turnEndSignal === "completed"
      ) {
        flushActivity(recordOffset);
        if (pendingAgent && pendingKey && !this.hasHookRegistration(target)) {
          this.insertMessageEvent(
            "assistant_final",
            target,
            binding.session_id,
            pendingKey,
            pendingAgent,
            `transcript-final:${binding.session_id}:${recordOffset}`,
          );
        }
        pendingAgent = null;
        pendingKey = null;
        pendingAt = null;
        this.deleteTurnActivity(target);
        activity = null;
        activityDirty = false;
      }
    }
    flushActivity(binding.cursor + completeBuffer.byteLength);
    this.updateBindingCursor(
      binding,
      binding.cursor + completeBuffer.byteLength,
      { pendingAgent, pendingKey, pendingAt, internalTurnId },
    );
  }

  private updateBindingCursor(
    binding: TranscriptBindingRow,
    cursor: number,
    pending: {
      readonly pendingAgent: string | null;
      readonly pendingKey: string | null;
      readonly pendingAt: number | null;
      readonly internalTurnId: string | null;
    },
  ): void {
    this.db.prepare(`
      UPDATE transcript_bindings
      SET cursor = ?, pending_agent = ?, pending_key = ?, pending_at = ?,
        internal_turn_id = ?, updated_at = ?
      WHERE server_pid = ? AND pane_id = ? AND pane_pid = ?
    `).run(
      cursor,
      pending.pendingAgent,
      pending.pendingKey,
      pending.pendingAt,
      pending.internalTurnId,
      Date.now(),
      binding.server_pid,
      binding.pane_id,
      binding.pane_pid,
    );
  }

  private rememberImageViewCall(
    target: CodexPaneIdentity,
    sessionId: string,
    callId: string,
  ): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT OR IGNORE INTO pending_image_views (
        server_pid, pane_id, pane_pid, session_id, call_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      target.serverPid,
      target.paneId,
      target.panePid,
      sessionId,
      callId,
      now,
    );
    this.db.prepare(`
      DELETE FROM pending_image_views WHERE created_at < ?
    `).run(now - 24 * 60 * 60 * 1_000);
  }

  private savePaneProfile(
    target: CodexPaneIdentity,
    profile: PaneProfile,
  ): void {
    this.db.prepare(`
      INSERT INTO pane_profiles (
        server_pid, pane_id, pane_pid, model, reasoning_effort,
        fast, cwd, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(server_pid, pane_id, pane_pid) DO UPDATE SET
        model = excluded.model,
        reasoning_effort = excluded.reasoning_effort,
        fast = excluded.fast,
        cwd = excluded.cwd,
        updated_at = excluded.updated_at
    `).run(
      target.serverPid,
      target.paneId,
      target.panePid,
      profile.model,
      profile.reasoningEffort,
      profile.fast ? 1 : 0,
      profile.cwd,
      Date.now(),
    );
  }

  private paneProfile(target: CodexPaneIdentity): PaneProfile | null {
    const row = this.db.prepare(`
      SELECT model, reasoning_effort, fast, cwd
      FROM pane_profiles
      WHERE server_pid = ? AND pane_id = ? AND pane_pid = ?
    `).get(
      target.serverPid,
      target.paneId,
      target.panePid,
    ) as {
      model: string;
      reasoning_effort: string;
      fast: number;
      cwd: string;
    } | undefined;
    if (!row) return null;
    return {
      model: row.model,
      reasoningEffort: normalizeProfileEffort(row.reasoning_effort),
      fast: row.fast === 1,
      cwd: normalizeCwd(row.cwd),
    };
  }

  private saveAssistantName(
    target: CodexPaneIdentity,
    assistantName: CodexAssistantName,
  ): void {
    if (assistantName !== "Lobby") {
      const existing = this.db.prepare(`
        SELECT assistant_name FROM pane_assistant_names
        WHERE server_pid = ? AND pane_id = ? AND pane_pid = ?
      `).get(
        target.serverPid,
        target.paneId,
        target.panePid,
      ) as { assistant_name: string } | undefined;
      if (existing?.assistant_name === "Lobby") return;
    }
    this.db.prepare(`
      INSERT INTO pane_assistant_names (
        server_pid, pane_id, pane_pid, assistant_name, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(server_pid, pane_id, pane_pid) DO UPDATE SET
        assistant_name = excluded.assistant_name,
        updated_at = excluded.updated_at
    `).run(
      target.serverPid,
      target.paneId,
      target.panePid,
      assistantName,
      Date.now(),
    );
  }

  private assistantNameForTarget(
    target: CodexPaneIdentity,
  ): CodexAssistantName {
    const row = this.db.prepare(`
      SELECT assistant_name FROM pane_assistant_names
      WHERE server_pid = ? AND pane_id = ? AND pane_pid = ?
    `).get(
      target.serverPid,
      target.paneId,
      target.panePid,
    ) as { assistant_name: string } | undefined;
    return row?.assistant_name === "Sol" ||
        row?.assistant_name === "Luna" ||
        row?.assistant_name === "Terra" ||
        row?.assistant_name === "Lobby"
      ? row.assistant_name
      : "Codex";
  }

  private hasAssistantName(target: CodexPaneIdentity): boolean {
    return this.db.prepare(`
      SELECT 1 FROM pane_assistant_names
      WHERE server_pid = ? AND pane_id = ? AND pane_pid = ?
    `).get(
      target.serverPid,
      target.paneId,
      target.panePid,
    ) !== undefined;
  }

  private consumeImageViewCall(
    target: CodexPaneIdentity,
    sessionId: string,
    callId: string,
  ): boolean {
    return this.db.prepare(`
      DELETE FROM pending_image_views
      WHERE server_pid = ? AND pane_id = ? AND pane_pid = ?
        AND session_id = ? AND call_id = ?
    `).run(
      target.serverPid,
      target.paneId,
      target.panePid,
      sessionId,
      callId,
    ).changes > 0;
  }

  /**
   * SessionStart can race the process-table discovery used for the public pane
   * list. Hook calls are already confined to the root/group Unix socket, so
   * validate the exact tmux pane directly as a startup/teardown fallback.
   */
  private async lookupTmuxPane(paneId: string): Promise<CodexPane | null> {
    try {
      const [serverRaw, paneRaw] = await Promise.all([
        run(TMUX, ["display-message", "-p", "#{pid}"]),
        run(TMUX, [
          "display-message",
          "-p",
          "-t",
          paneId,
          [
            "#{pane_id}",
            "#{pane_pid}",
            "#{session_name}",
            "#{window_name}",
            "#{window_index}",
            "#{pane_current_path}",
            "#{pane_active}",
          ].join("\u001f"),
        ]),
      ]);
      const fields = paneRaw.trim().split("\u001f");
      if (fields.length !== 7 || fields[0] !== paneId) return null;
      return {
        serverPid: parsePositiveInteger(serverRaw.trim()),
        paneId,
        panePid: parsePositiveInteger(fields[1]),
        sessionName: normalizeLabel(fields[2], 80),
        windowName: normalizeLabel(fields[3], 80),
        windowIndex: parseNonNegativeInteger(fields[4]),
        cwd: normalizeCwd(fields[5]),
        active: fields[6] === "1",
        busy: false,
        codexPid: 0,
      };
    } catch {
      return null;
    }
  }

  private migrateHookSessions(): void {
    const columns = new Set(
      (this.db.prepare(`PRAGMA table_info(hook_sessions)`).all() as unknown as
        Array<{ name: string }>).map((column) => column.name),
    );
    if (!columns.has("busy")) {
      this.db.exec(
        `ALTER TABLE hook_sessions ADD COLUMN busy INTEGER NOT NULL DEFAULT 0`,
      );
    }
  }

  private migrateEvents(): void {
    const columns = new Set(
      (this.db.prepare(`PRAGMA table_info(stop_events)`).all() as unknown as
        Array<{ name: string }>).map((column) => column.name),
    );
    if (!columns.has("kind")) {
      this.db.exec(`
        ALTER TABLE stop_events
        ADD COLUMN kind TEXT NOT NULL DEFAULT 'assistant_final'
      `);
    }
    if (!columns.has("turn_started_at")) {
      this.db.exec(`
        ALTER TABLE stop_events
        ADD COLUMN turn_started_at INTEGER NOT NULL DEFAULT 0
      `);
    }
  }

  private migrateTranscriptBindings(): void {
    const columns = new Set(
      (this.db.prepare(`PRAGMA table_info(transcript_bindings)`).all() as
        unknown as Array<{ name: string }>).map((column) => column.name),
    );
    if (!columns.has("internal_turn_id")) {
      this.db.exec(
        `ALTER TABLE transcript_bindings ADD COLUMN internal_turn_id TEXT`,
      );
    }
  }

  private migrateTurnActivity(): void {
    const columns = new Set(
      (this.db.prepare(`PRAGMA table_info(turn_activity)`).all() as unknown as
        Array<{ name: string }>).map((column) => column.name),
    );
    const additions = [
      ["explored_things", "INTEGER NOT NULL DEFAULT 0"],
      ["reasoning_summary_keys", "TEXT NOT NULL DEFAULT '[]'"],
      ["active_shells", "TEXT NOT NULL DEFAULT '[]'"],
      ["pending_shell_calls", "TEXT NOT NULL DEFAULT '{}'"],
      ["started_at", "INTEGER NOT NULL DEFAULT 0"],
    ] as const;
    for (const [name, definition] of additions) {
      if (!columns.has(name)) {
        this.db.exec(
          `ALTER TABLE turn_activity ADD COLUMN ${name} ${definition}`,
        );
      }
    }
  }
}

async function readProcesses(): Promise<ProcessRow[]> {
  const output = await run(PS, ["-eo", "pid=,ppid=,args="]);
  const rows: ProcessRow[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\s\S]+)$/u.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      args: match[3],
    });
  }
  return rows;
}

function indexChildren(rows: readonly ProcessRow[]): Map<number, ProcessRow[]> {
  const index = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const bucket = index.get(row.ppid) ?? [];
    bucket.push(row);
    index.set(row.ppid, bucket);
  }
  return index;
}

function findCodexDescendant(
  panePid: number,
  children: ReadonlyMap<number, readonly ProcessRow[]>,
): number | null {
  const queue = [...(children.get(panePid) ?? [])];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const process = queue.shift()!;
    if (seen.has(process.pid)) continue;
    seen.add(process.pid);
    const normalized = process.args.replace(/\s+/gu, " ");
    if (
      /(?:^|\s|\/)codex(?:\s|$)/u.test(normalized) &&
      !/\b(?:app-server|exec-server|mcp-server)\b/u.test(normalized)
    ) {
      return process.pid;
    }
    queue.push(...(children.get(process.pid) ?? []));
  }
  return null;
}

async function run(
  file: string,
  args: readonly string[],
  input?: string,
): Promise<string> {
  return (
    await runBuffer(
      file,
      args,
      input === undefined ? undefined : Buffer.from(input, "utf8"),
      2 * 1024 * 1024,
    )
  ).toString("utf8");
}

async function runBuffer(
  file: string,
  args: readonly string[],
  input: Buffer | undefined,
  maxOutputBytes: number,
  timeoutMs = 5_000,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(file, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error(`${file} timed out`)));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        child.kill("SIGKILL");
        finish(() => reject(new Error(`${file} output was too large`)));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => {
      finish(() => {
        if (code === 0) {
          resolve(Buffer.concat(stdout));
        } else {
          reject(
            new Error(
              Buffer.concat(stderr).toString("utf8").trim() ||
                `${file} exited with code ${code ?? "unknown"}`,
            ),
          );
        }
      });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function waitForPane(
  list: () => Promise<CodexPane[]>,
  predicate: (pane: CodexPane) => boolean,
): Promise<CodexPane | null> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const found = (await list()).find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

function parsePositiveInteger(value: string): number {
  if (!/^\d+$/u.test(value)) throw new Error("Expected positive integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("Expected positive integer");
  }
  return parsed;
}

function parseNonNegativeInteger(value: string): number {
  if (!/^\d+$/u.test(value)) throw new Error("Expected non-negative integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Expected non-negative integer");
  }
  return parsed;
}

function normalizeLabel(value: string, max: number): string {
  const normalized = value
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .trim();
  return [...normalized].slice(0, max).join("");
}

function normalizeCwd(value: string): string {
  return value.includes("\u0000") ? "/" : value.slice(0, 4_096);
}

function normalizeDeliveryId(value: unknown): string | null {
  if (value === undefined) return null;
  return typeof value === "string" &&
      value.length >= 1 &&
      value.length <= 160 &&
      /^[A-Za-z0-9:_.-]+$/u.test(value)
    ? value
    : null;
}

const WORKSPACE_SCAN_LIMIT = 32;
const WORKSPACE_SCAN_DEPTH = 3;
const WORKSPACE_DIRECTORY_VISIT_LIMIT = 384;
const WORKSPACE_IGNORED_DIRECTORIES = new Set([
  ".cache",
  ".codex",
  ".config",
  ".local",
  ".npm",
  ".rustup",
  ".ssh",
  ".tmux",
  ".venv",
  "build",
  "dist",
  "node_modules",
  "target",
  "vendor",
]);

export async function discoverCodexWorkspaces(
  configuredRoots: readonly string[],
): Promise<CodexWorkspace[]> {
  const roots = [...new Set(configuredRoots
    .map((root) => root.trim())
    .filter((root) => root && path.isAbsolute(root))
    .map((root) => path.resolve(root)))];
  const workspaces = new Map<string, CodexWorkspace>();
  let visitedDirectories = 0;

  const visit = async (
    directory: string,
    depth: number,
    configuredRoot: boolean,
  ): Promise<void> => {
    if (
      workspaces.size >= WORKSPACE_SCAN_LIMIT ||
      visitedDirectories >= WORKSPACE_DIRECTORY_VISIT_LIMIT
    ) return;
    visitedDirectories += 1;
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    );
    const isRepository = entries.some((entry) => entry.name === ".git");
    if (isRepository) {
      const canonical = await realpath(directory).catch(() => directory);
      workspaces.set(canonical, {
        path: canonical,
        name: path.basename(canonical) || canonical,
      });
      if (!configuredRoot) return;
    }
    if (depth >= WORKSPACE_SCAN_DEPTH) return;
    const children = entries
      .filter((entry) =>
        entry.isDirectory() &&
        !WORKSPACE_IGNORED_DIRECTORIES.has(entry.name) &&
        !entry.name.startsWith("."))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      await visit(path.join(directory, child.name), depth + 1, false);
      if (
        workspaces.size >= WORKSPACE_SCAN_LIMIT ||
        visitedDirectories >= WORKSPACE_DIRECTORY_VISIT_LIMIT
      ) break;
    }
  };

  for (const root of roots) {
    await visit(root, 0, true);
    if (workspaces.size >= WORKSPACE_SCAN_LIMIT) break;
  }
  return [...workspaces.values()].sort((left, right) =>
    left.name.localeCompare(right.name) || left.path.localeCompare(right.path)
  );
}

function normalizeRequestedName(value: unknown): string {
  const normalized =
    typeof value === "string" ? normalizeLabel(value, 128) : "";
  return normalized ||
    `Session · ${new Date().toISOString().slice(11, 16).replace(":", "")}`;
}

function normalizeRequestedCwd(value: unknown, fallback: string): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!candidate) return fallback;
  if (
    !path.isAbsolute(candidate) ||
    candidate.includes("\u0000") ||
    candidate.length > 4_096
  ) {
    throw new Error("Working directory must be an absolute path");
  }
  return candidate;
}

function normalizeRequestedTmuxSession(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const normalized = normalizeLabel(value, 60);
  return /^[A-Za-z0-9_.-]+$/u.test(normalized) ? normalized : null;
}

export function fullAccessCodexCommand(): string {
  return (
    `${shellArgument(CODEX)} --dangerously-bypass-approvals-and-sandbox ` +
    "--dangerously-bypass-hook-trust " +
    `-c 'model_reasoning_summary="detailed"' ` +
    `-c 'model_verbosity="medium"' ` +
    `-c 'personality="friendly"' ` +
    `-c 'web_search="live"' ` +
    `-c 'plan_mode_reasoning_effort="high"' ` +
    `-c 'hide_agent_reasoning=false' ` +
    `-c 'show_raw_agent_reasoning=false' ` +
    `-c 'service_tier="default"' ` +
    "--disable fast_mode --enable hooks"
  );
}

export function workerCodexCommand(input: {
  readonly model: "sol" | "luna" | "terra";
  readonly reasoningEffort: "low" | "medium" | "high" | "xhigh";
  readonly fast: boolean;
}, trustedCwd?: string): string {
  const tier = input.fast
    ? ` -c 'service_tier="fast"' --enable fast_mode`
    : "";
  const trust = trustedCwd
    ? ` -c ${shellArgument(
      `projects.${JSON.stringify(
        path.resolve(trustedCwd),
      )}.trust_level="trusted"`,
    )}`
    : "";
  return (
    `${fullAccessCodexCommand()} ` +
    `-c 'model="${modelForProfile(input.model)}"' ` +
    `-c 'model_reasoning_effort="${input.reasoningEffort}"'` +
    tier +
    trust
  );
}

export function lobbyCodexCommand(lobbyCwd: string): string {
  return workerCodexCommand({
    model: "terra",
    reasoningEffort: "low",
    fast: true,
  }, lobbyCwd) +
    ` -c 'model_reasoning_summary="concise"'` +
    ` -c 'model_verbosity="low"'`;
}

export function managedCodexStartupState(
  screen: string,
): "starting" | "directory_trust" | "ready" {
  if (
    /Do you trust the contents of this directory\?/iu.test(screen) &&
    /1\.\s*Yes,\s*continue/iu.test(screen)
  ) {
    return "directory_trust";
  }
  if (
    /^\s*›(?:\s|$)/mu.test(screen) &&
    (
      /\bgpt-[\w.-]+\b/iu.test(screen) ||
      /Use \/skills to list available skills/iu.test(screen)
    )
  ) {
    return "ready";
  }
  return "starting";
}

function modelForProfile(profile: "sol" | "luna" | "terra"): string {
  const key = `CHATINABOX_${profile.toUpperCase()}_MODEL`;
  return process.env[key]?.trim() || `gpt-5.6-${profile}`;
}

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function normalizeWorkerModel(
  value: unknown,
): "sol" | "luna" | "terra" {
  return value === "luna" || value === "terra" ? value : "sol";
}

function profileModelFamily(
  model: unknown,
  assistantName: unknown,
): "sol" | "luna" | "terra" {
  const normalized = typeof model === "string" ? model.toLowerCase() : "";
  if (normalized.includes("luna") || assistantName === "Luna") return "luna";
  if (normalized.includes("terra") || assistantName === "Terra") return "terra";
  return "sol";
}

function normalizeWorkerReasoningEffort(
  value: unknown,
): "low" | "medium" | "high" | "xhigh" {
  return value === "low" || value === "medium" || value === "xhigh"
    ? value
    : "high";
}

function normalizeProfileEffort(
  value: unknown,
): "low" | "medium" | "high" | "xhigh" {
  return value === "low" ||
      value === "medium" ||
      value === "xhigh"
    ? value
    : "high";
}

function transcriptPaneProfile(
  record: Record<string, unknown>,
  current: PaneProfile | null,
): PaneProfile | null {
  if (!isPlainRecord(record.payload)) return null;
  const payload = record.payload;
  let source: Record<string, unknown> | null = null;
  if (record.type === "turn_context") {
    source = payload;
  } else if (
    record.type === "event_msg" &&
    payload.type === "thread_settings_applied" &&
    isPlainRecord(payload.thread_settings)
  ) {
    source = payload.thread_settings;
  }
  if (!source) return null;
  const model =
    typeof source.model === "string" && source.model.trim()
      ? source.model.trim().slice(0, 160)
      : current?.model;
  const effortValue = source.reasoning_effort ?? source.effort;
  const reasoningEffort = effortValue === undefined
    ? current?.reasoningEffort
    : normalizeProfileEffort(effortValue);
  const cwd =
    typeof source.cwd === "string" && source.cwd.trim()
      ? normalizeCwd(source.cwd.trim())
      : current?.cwd;
  if (!model || !reasoningEffort || !cwd) return null;
  const serviceTier = typeof source.service_tier === "string"
    ? source.service_tier
    : null;
  return {
    model,
    reasoningEffort,
    fast: serviceTier === null ? current?.fast === true : serviceTier === "fast",
    cwd,
  };
}

function transcriptRecordTime(record: Record<string, unknown>): number | null {
  if (typeof record.timestamp !== "string") return null;
  const parsed = Date.parse(record.timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseNumberSet(value: string): Set<number> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter(
        (candidate): candidate is number =>
          Number.isSafeInteger(candidate) && Number(candidate) > 0,
      ).slice(0, 64),
    );
  } catch {
    return new Set();
  }
}

function parseStringSet(value: string): Set<string> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter(
        (candidate): candidate is string =>
          typeof candidate === "string" &&
          /^[a-f0-9]{64}$/u.test(candidate),
      ).slice(0, 500),
    );
  } catch {
    return new Set();
  }
}

export function reasoningSummaryKey(value: string): string {
  const normalized = value
    .trim()
    .replace(/^\*{2}([\s\S]*?)\*{2}$/u, "$1")
    .replace(/\s+/gu, " ")
    .replace(/[.…]+$/u, "")
    .toLocaleLowerCase("en-US");
  return createHash("sha256").update(normalized).digest("hex");
}

function parseNumberMap(value: string): Map<string, number> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isPlainRecord(parsed)) return new Map();
    return new Map(
      Object.entries(parsed)
        .filter(
          (entry): entry is [string, number] =>
            entry[0].length <= 300 &&
            Number.isSafeInteger(entry[1]) &&
            Number(entry[1]) > 0,
        )
        .slice(0, 64),
    );
  } catch {
    return new Map();
  }
}

export function shellSessionFromToolInput(
  payload: Record<string, unknown>,
): number | null {
  if (payload.name !== "write_stdin") return null;
  let input = payload.input;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input) as unknown;
    } catch {
      return null;
    }
  }
  if (!isPlainRecord(input)) return null;
  return Number.isSafeInteger(input.session_id) && Number(input.session_id) > 0
    ? Number(input.session_id)
    : null;
}

export function shellSessionFromToolOutput(
  payload: Record<string, unknown>,
): number | null {
  const values = Array.isArray(payload.output)
    ? payload.output
    : [payload.output];
  for (const value of values) {
    const text = isPlainRecord(value) && typeof value.text === "string"
      ? value.text
      : typeof value === "string"
        ? value
        : "";
    if (!text) continue;
    const trimmed = text.trim();
    if (trimmed.startsWith("{") && trimmed.length <= 20_000) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (
          isPlainRecord(parsed) &&
          Number.isSafeInteger(parsed.session_id) &&
          Number(parsed.session_id) > 0
        ) {
          return Number(parsed.session_id);
        }
      } catch {
        // Some legacy tool outputs are plain text rather than JSON.
      }
    }
    const legacy = /(?:session id|session_id)\D{0,8}(\d{1,12})/iu.exec(text);
    if (legacy) return Number(legacy[1]);
  }
  return null;
}

function stringField(
  record: Record<string, unknown>,
  key: string,
  maxBytes: number,
): string | null {
  const value = record[key];
  if (
    typeof value !== "string" ||
    value.includes("\u0000") ||
    Buffer.byteLength(value) > maxBytes
  ) {
    return null;
  }
  return value;
}

function failure(code: string, error: string): CodexBridgeResponse {
  return { ok: false, code, error };
}

function isCodexEventKind(value: unknown): value is CodexEventKind {
  return (
    value === "assistant_final" ||
    value === "assistant_progress" ||
    value === "agent_reasoning" ||
    value === "context_compacted" ||
    value === "image_viewed" ||
    value === "session_renamed" ||
    value === "session_handoff" ||
    value === "user_local" ||
    value === "state_compacting" ||
    value === "state_working" ||
    value === "state_waiting_terminal" ||
    value === "state_activity" ||
    value === "turn_aborted"
  );
}

export function transcriptCompactionSignal(
  record: unknown,
): "started" | "completed" | null {
  if (!isPlainRecord(record)) return null;
  if (record.type === "compacted") return "started";
  return (
      record.type === "event_msg" &&
      isPlainRecord(record.payload) &&
      record.payload.type === "context_compacted"
    )
    ? "completed"
    : null;
}

export function transcriptTurnEndSignal(
  record: unknown,
): "completed" | "aborted" | null {
  if (
    !isPlainRecord(record) ||
    record.type !== "event_msg" ||
    !isPlainRecord(record.payload)
  ) {
    return null;
  }
  return record.payload.type === "task_complete"
    ? "completed"
    : record.payload.type === "turn_aborted"
      ? "aborted"
      : null;
}

export function isCompactedTranscriptPrefix(buffer: Buffer): boolean {
  const prefix = buffer
    .subarray(0, Math.min(buffer.byteLength, 1_024))
    .toString("utf8");
  return (
    /^\s*\{/u.test(prefix) &&
    /"type"\s*:\s*"compacted"/u.test(prefix)
  );
}

function promptHash(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

interface TerminalStyle {
  foreground: string;
  background: string;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}

interface TerminalSegment {
  text: string;
  style: TerminalStyle;
}

const TERMINAL_FOREGROUND = "#e6edf3";
const TERMINAL_BACKGROUND = "#0d1117";
const ANSI_BASIC_COLORS = [
  "#1f2428",
  "#ff7b72",
  "#3fb950",
  "#d29922",
  "#58a6ff",
  "#bc8cff",
  "#39c5cf",
  "#b1bac4",
  "#6e7681",
  "#ffa198",
  "#56d364",
  "#e3b341",
  "#79c0ff",
  "#d2a8ff",
  "#56d4dd",
  "#f0f6fc",
] as const;

export function renderAnsiTerminalSvg(input: string): {
  readonly svg: string;
  readonly width: number;
  readonly height: number;
} {
  const lines = input.replace(/\r/gu, "").split("\n").slice(-100);
  while (lines.length > 1 && stripAnsi(lines[lines.length - 1]) === "") lines.pop();
  const width = 2_000;
  const lineHeight = 40;
  const cellWidth = 17.5;
  const left = 40;
  const baseline = 66;
  const height = Math.max(300, Math.min(4_000, 80 + lines.length * lineHeight));
  const parsed = lines.map(parseAnsiLine);
  const backgrounds: string[] = [];
  const textRows: string[] = [];
  for (let row = 0; row < parsed.length; row += 1) {
    let column = 0;
    const spans: string[] = [];
    for (const segment of parsed[row]) {
      if (!segment.text) continue;
      const style = effectiveTerminalStyle(segment.style);
      const columns = visualWidth(segment.text);
      if (style.background !== TERMINAL_BACKGROUND && columns > 0) {
        backgrounds.push(
          `<rect x="${left + column * cellWidth}" y="${baseline - 31 + row * lineHeight}" ` +
          `width="${columns * cellWidth}" height="${lineHeight}" fill="${style.background}"/>`,
        );
      }
      const decorations = [
        style.bold ? 'font-weight="700"' : "",
        style.italic ? 'font-style="italic"' : "",
        style.underline ? 'text-decoration="underline"' : "",
        style.dim ? 'opacity="0.62"' : "",
      ].filter(Boolean).join(" ");
      spans.push(
        `<tspan x="${left + column * cellWidth}" fill="${style.foreground}" ` +
        `${decorations}>${escapeXml(segment.text)}</tspan>`,
      );
      column += columns;
    }
    textRows.push(
      `<text x="${left}" y="${baseline + row * lineHeight}" ` +
      `font-family="DejaVu Sans Mono, monospace" font-size="29">${spans.join("")}</text>`,
    );
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect width="100%" height="100%" fill="${TERMINAL_BACKGROUND}"/>` +
    backgrounds.join("") +
    textRows.join("") +
    "</svg>";
  return { svg, width, height };
}

export function buildClarityTerminalHtml(
  input: string,
  title: string,
): {
  readonly html: string;
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly outputWidth: number;
  readonly outputHeight: number;
} {
  const rendered = renderAnsiTerminalSvg(input);
  const focusHeight = Math.min(2_250, rendered.height);
  const focusY = Math.max(0, rendered.height - focusHeight);
  const svg = rendered.svg
    .replace(
      /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="\d+" height="\d+">/u,
      `<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="${focusHeight}" ` +
        `viewBox="0 ${focusY} 2000 ${focusHeight}">` +
        "<style>text { font-weight: 550; text-rendering: geometricPrecision; }</style>",
    )
    .replace(
      `<rect width="100%" height="100%" fill="${TERMINAL_BACKGROUND}"/>`,
      `<rect x="0" y="${focusY}" width="2000" height="${focusHeight}" ` +
        `fill="${TERMINAL_BACKGROUND}"/>`,
    );
  const cssWidth = 2_064;
  const cssHeight = focusHeight + 132;
  const outputWidth = cssWidth * 2;
  const outputHeight = cssHeight * 2;
  const safeTitle = escapeXml(title);
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
* { box-sizing: border-box; }
html, body {
  margin: 0;
  background: #06090f;
  color: #e6edf3;
  font-family: "DejaVu Sans Mono", monospace;
}
body { width: ${cssWidth}px; padding: 24px 32px 32px; }
#frame {
  overflow: hidden;
  border: 1px solid #30363d;
  border-radius: 20px;
  background: #0d1117;
  box-shadow: 0 24px 80px rgba(0,0,0,.55);
}
#bar {
  height: 76px;
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 0 28px;
  border-bottom: 1px solid #30363d;
  background: linear-gradient(180deg, #181d27, #11161f);
  letter-spacing: .4px;
}
.lights { display: flex; gap: 10px; margin-right: 4px; }
.light { width: 15px; height: 15px; border-radius: 50%; }
.red { background: #ff7b72; }
.amber { background: #d29922; }
.green { background: #3fb950; }
.title { font-size: 24px; font-weight: 700; }
.meta {
  margin-left: auto;
  color: #9da7b3;
  font-size: 20px;
  font-weight: 550;
}
#terminal {
  width: 2000px;
  height: ${focusHeight}px;
  background: #0d1117;
}
#terminal svg { display: block; }
</style>
</head>
<body>
<main id="frame">
  <header id="bar">
    <div class="lights">
      <span class="light red"></span>
      <span class="light amber"></span>
      <span class="light green"></span>
    </div>
    <div class="title">CODEX · ${safeTitle}</div>
    <div class="meta">FOCUS VIEW · ANSI TRUECOLOR · 2× SHARP</div>
  </header>
  <section id="terminal">${svg}</section>
</main>
</body>
</html>`;
  return { html, cssWidth, cssHeight, outputWidth, outputHeight };
}

async function renderClarityTerminalPng(
  input: string,
  title: string,
): Promise<{
  readonly png: Buffer;
  readonly width: number;
  readonly height: number;
}> {
  const rendered = buildClarityTerminalHtml(input, title);
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    pipe: true,
    timeout: 12_000,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      "--disable-crash-reporter",
    ],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({
      width: rendered.cssWidth,
      height: rendered.cssHeight,
      deviceScaleFactor: 2,
    });
    await page.setContent(rendered.html, { waitUntil: "load" });
    const screenshot = await page.screenshot({
      type: "png",
      captureBeyondViewport: true,
    });
    return {
      png: Buffer.from(screenshot),
      width: rendered.outputWidth,
      height: rendered.outputHeight,
    };
  } finally {
    await browser.close();
  }
}

function parseAnsiLine(line: string): TerminalSegment[] {
  let style = defaultTerminalStyle();
  const segments: TerminalSegment[] = [];
  let cursor = 0;
  const pattern = /\u001b\[([0-9;]*)m/gu;
  for (const match of line.matchAll(pattern)) {
    const index = match.index ?? 0;
    appendTerminalText(segments, line.slice(cursor, index), style);
    style = applySgr(style, match[1]);
    cursor = index + match[0].length;
  }
  appendTerminalText(segments, line.slice(cursor), style);
  return segments;
}

function appendTerminalText(
  segments: TerminalSegment[],
  value: string,
  style: TerminalStyle,
): void {
  const text = value
    .replace(/\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~])/gu, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "�");
  if (text) segments.push({ text, style: { ...style } });
}

function applySgr(current: TerminalStyle, raw: string): TerminalStyle {
  const values = (raw === "" ? [0] : raw.split(";").map(Number));
  let style = { ...current };
  for (let index = 0; index < values.length; index += 1) {
    const code = values[index];
    if (code === 0) style = defaultTerminalStyle();
    else if (code === 1) style.bold = true;
    else if (code === 2) style.dim = true;
    else if (code === 3) style.italic = true;
    else if (code === 4) style.underline = true;
    else if (code === 7) style.inverse = true;
    else if (code === 22) {
      style.bold = false;
      style.dim = false;
    } else if (code === 23) style.italic = false;
    else if (code === 24) style.underline = false;
    else if (code === 27) style.inverse = false;
    else if (code === 39) style.foreground = TERMINAL_FOREGROUND;
    else if (code === 49) style.background = TERMINAL_BACKGROUND;
    else if (code >= 30 && code <= 37) {
      style.foreground = ANSI_BASIC_COLORS[code - 30];
    } else if (code >= 90 && code <= 97) {
      style.foreground = ANSI_BASIC_COLORS[code - 90 + 8];
    } else if (code >= 40 && code <= 47) {
      style.background = ANSI_BASIC_COLORS[code - 40];
    } else if (code >= 100 && code <= 107) {
      style.background = ANSI_BASIC_COLORS[code - 100 + 8];
    } else if ((code === 38 || code === 48) && values[index + 1] === 5) {
      const color = xtermColor(values[index + 2]);
      if (color) {
        if (code === 38) style.foreground = color;
        else style.background = color;
      }
      index += 2;
    } else if ((code === 38 || code === 48) && values[index + 1] === 2) {
      const red = colorByte(values[index + 2]);
      const green = colorByte(values[index + 3]);
      const blue = colorByte(values[index + 4]);
      if (red !== null && green !== null && blue !== null) {
        const color = `rgb(${red},${green},${blue})`;
        if (code === 38) style.foreground = color;
        else style.background = color;
      }
      index += 4;
    }
  }
  return style;
}

function defaultTerminalStyle(): TerminalStyle {
  return {
    foreground: TERMINAL_FOREGROUND,
    background: TERMINAL_BACKGROUND,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    inverse: false,
  };
}

function effectiveTerminalStyle(style: TerminalStyle): TerminalStyle {
  if (!style.inverse) return style;
  return {
    ...style,
    foreground: style.background,
    background: style.foreground,
  };
}

function xtermColor(value: number | undefined): string | null {
  if (!Number.isInteger(value) || value! < 0 || value! > 255) return null;
  if (value! < 16) return ANSI_BASIC_COLORS[value!];
  if (value! < 232) {
    const offset = value! - 16;
    const levels = [0, 95, 135, 175, 215, 255];
    const red = levels[Math.floor(offset / 36) % 6];
    const green = levels[Math.floor(offset / 6) % 6];
    const blue = levels[offset % 6];
    return `rgb(${red},${green},${blue})`;
  }
  const gray = 8 + (value! - 232) * 10;
  return `rgb(${gray},${gray},${gray})`;
}

function colorByte(value: number | undefined): number | null {
  return Number.isInteger(value) && value! >= 0 && value! <= 255 ? value! : null;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~])/gu, "");
}

function visualWidth(value: string): number {
  let width = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (/\p{Mark}/u.test(character) || code === 0xfe0f || code === 0x200d) continue;
    width += isWideCodePoint(code) || /\p{Extended_Pictographic}/u.test(character) ? 2 : 1;
  }
  return width;
}

function isWideCodePoint(code: number): boolean {
  return (
    code >= 0x1100 &&
    (
      code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x3fffd)
    )
  );
}

export function splitCompleteTranscriptChunk(buffer: Buffer): {
  readonly complete: Buffer;
  readonly consumedBytes: number;
} {
  const lastNewline = buffer.lastIndexOf(0x0a);
  return lastNewline < 0
    ? { complete: Buffer.alloc(0), consumedBytes: buffer.byteLength }
    : {
        complete: buffer.subarray(0, lastNewline + 1),
        consumedBytes: lastNewline + 1,
  };
}

async function discoverTranscriptAssistantName(
  transcriptPath: string,
  fileSize: number,
): Promise<CodexAssistantName | null> {
  const bytesToRead = Math.min(fileSize, MODEL_DISCOVERY_TAIL_BYTES);
  if (bytesToRead <= 0) return null;
  const start = fileSize - bytesToRead;
  const file = await openFile(transcriptPath, "r");
  let buffer: Buffer;
  try {
    buffer = Buffer.alloc(bytesToRead);
    const result = await file.read(buffer, 0, bytesToRead, start);
    buffer = buffer.subarray(0, result.bytesRead);
  } finally {
    await file.close();
  }
  const lines = buffer.toString("utf8").split("\n");
  if (start > 0) lines.shift();
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let record: unknown;
    try {
      record = JSON.parse(lines[index]);
    } catch {
      continue;
    }
    if (
      isPlainRecord(record) &&
      record.type === "turn_context" &&
      isPlainRecord(record.payload) &&
      typeof record.payload.model === "string"
    ) {
      return assistantNameForModel(record.payload.model);
    }
  }
  return null;
}

interface TranscriptParserState {
  readonly prompt: string;
  readonly startedAt: number;
  readonly promptSeen: boolean;
  readonly assistantMessage: string | null;
}

interface TranscriptParserResult {
  readonly carry: string;
  readonly promptSeen: boolean;
  readonly assistantMessage: string | null;
  readonly complete: boolean;
}

export function consumeTranscriptLines(
  input: string,
  state: TranscriptParserState,
): TranscriptParserResult {
  const lines = input.split("\n");
  const carry = lines.pop() ?? "";
  let promptSeen = state.promptSeen;
  let assistantMessage = state.assistantMessage;
  let complete = false;
  for (const line of lines) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPlainRecord(record) || !isPlainRecord(record.payload)) continue;
    const timestamp =
      typeof record.timestamp === "string"
        ? Date.parse(record.timestamp)
        : Number.NaN;
    const payload = record.payload;
    if (
      !promptSeen &&
      record.type === "response_item" &&
      payload.type === "message" &&
      payload.role === "user" &&
      timestamp >= state.startedAt - 5_000 &&
      transcriptMessageText(payload) === state.prompt
    ) {
      promptSeen = true;
      assistantMessage = null;
      continue;
    }
    if (!promptSeen) continue;
    if (
      record.type === "response_item" &&
      payload.type === "message" &&
      payload.role === "assistant"
    ) {
      assistantMessage = transcriptMessageText(payload);
      continue;
    }
    if (
      record.type === "event_msg" &&
      payload.type === "task_complete"
    ) {
      complete = true;
    }
  }
  return { carry, promptSeen, assistantMessage, complete };
}

function transcriptMessageText(payload: Record<string, unknown>): string {
  if (!Array.isArray(payload.content)) return "";
  return payload.content
    .filter(isPlainRecord)
    .map((part) => typeof part.text === "string" ? part.text : "")
    .join("");
}

/** Read the newest account-wide Codex rate-limit snapshot from rollout JSONL. */
export function parseCodexUsageFromTranscriptTail(
  contents: string,
): CodexUsage | null {
  const lines = contents.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let record: unknown;
    try {
      record = JSON.parse(lines[index]);
    } catch {
      continue;
    }
    if (
      !isPlainRecord(record) ||
      record.type !== "event_msg" ||
      typeof record.timestamp !== "string" ||
      !isPlainRecord(record.payload) ||
      record.payload.type !== "token_count" ||
      !isPlainRecord(record.payload.rate_limits)
    ) {
      continue;
    }
    const observedAt = Date.parse(record.timestamp);
    if (!Number.isFinite(observedAt)) continue;
    const rateLimits = record.payload.rate_limits;
    const limits = [rateLimits.primary, rateLimits.secondary]
      .map(parseCodexUsageLimit)
      .filter((limit): limit is CodexUsageLimit => limit !== null);
    if (limits.length === 0) continue;
    const credits = isPlainRecord(rateLimits.credits)
      ? rateLimits.credits.balance
      : null;
    return {
      observedAt,
      planType:
        typeof rateLimits.plan_type === "string"
          ? rateLimits.plan_type
          : null,
      creditsBalance:
        typeof credits === "string" && credits.trim()
          ? credits.trim().slice(0, 40)
          : null,
      limits,
    };
  }
  return null;
}

/** Read current context occupancy from the newest complete token-count record. */
export function parseCodexContextUsedPercentFromTranscriptTail(
  contents: string,
): number | null {
  const lines = contents.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let record: unknown;
    try {
      record = JSON.parse(lines[index]);
    } catch {
      continue;
    }
    if (
      !isPlainRecord(record) ||
      record.type !== "event_msg" ||
      !isPlainRecord(record.payload) ||
      record.payload.type !== "token_count" ||
      !isPlainRecord(record.payload.info) ||
      !isPlainRecord(record.payload.info.last_token_usage)
    ) {
      continue;
    }
    const tokens = Number(record.payload.info.last_token_usage.total_tokens);
    const window = Number(record.payload.info.model_context_window);
    if (
      !Number.isSafeInteger(tokens) ||
      tokens < 0 ||
      !Number.isSafeInteger(window) ||
      window <= 0
    ) {
      continue;
    }
    return Math.max(0, Math.min(100, Math.round((tokens / window) * 100)));
  }
  return null;
}

export function transcriptReasoningSummaries(record: unknown): string[] {
  if (
    !isPlainRecord(record) ||
    record.type !== "response_item" ||
    !isPlainRecord(record.payload) ||
    record.payload.type !== "reasoning" ||
    !Array.isArray(record.payload.summary)
  ) {
    return [];
  }
  return record.payload.summary
    .filter(isPlainRecord)
    .filter((item) => item.type === "summary_text")
    .map((item) => typeof item.text === "string" ? item.text.trim() : "")
    .filter(Boolean)
    .map((text) => text.slice(0, 1_000))
    .slice(0, 20);
}

/**
 * Codex records a few runtime/developer context envelopes as user-role
 * transcript items. They are not authored chat messages and must never be
 * mirrored back into Telegram as if the user sent them from a VPS terminal.
 */
export function isInternalCodexPrompt(value: string): boolean {
  const prompt = value.trimStart();
  return isInternalMaintenancePrompt(prompt) ||
    prompt.startsWith("# AGENTS.md instructions\n") ||
    prompt.startsWith("<environment_context>") ||
    prompt.startsWith("<permissions instructions>") ||
    prompt.startsWith("<collaboration_mode>") ||
    prompt.startsWith("<apps_instructions>") ||
    prompt.startsWith("<plugins_instructions>") ||
    prompt.startsWith("<skills_instructions>") ||
    prompt.startsWith("<codex_internal_context source=\"goal\">") ||
    prompt.startsWith("## Memory\n\nYou have access to a memory folder") ||
    prompt.startsWith(
      "You are `/root`, the primary agent in a team of agents collaborating",
    );
}

/**
 * Codex memory maintenance is a background turn in an existing CLI session.
 * Its prompt, activity, reasoning, and final report are implementation detail,
 * not conversation content. Match the structured envelope rather than a loose
 * keyword so a user can still discuss the feature normally.
 */
export function isInternalMaintenancePrompt(value: string): boolean {
  const prompt = value.trimStart().replaceAll("\r\n", "\n");
  return /^#?\s*Memory Writing Agent:\s*Phase\s+(?:1|2)\b[^\n]*\n+You are a Memory Writing Agent\b/iu
    .test(prompt);
}

export function localPromptRelayText(value: string): string {
  const bytes = Buffer.byteLength(value);
  if (bytes <= MAX_LOCAL_PROMPT_RELAY_BYTES) return value;
  return `[local VPS prompt omitted · ${bytes.toLocaleString("en-US")} bytes]`;
}

function transcriptUserPrompt(
  record: Record<string, unknown>,
  payload: Record<string, unknown>,
): string | null {
  if (
    record.type === "event_msg" &&
    payload.type === "user_message" &&
    typeof payload.message === "string"
  ) {
    return payload.message;
  }
  if (
    record.type === "response_item" &&
    payload.type === "message" &&
    payload.role === "user"
  ) {
    return transcriptMessageText(payload);
  }
  return null;
}

function parseCodexUsageLimit(value: unknown): CodexUsageLimit | null {
  if (!isPlainRecord(value)) return null;
  const usedPercent = Number(value.used_percent);
  const windowMinutes = Number(value.window_minutes);
  const resetsAt = Number(value.resets_at);
  if (
    !Number.isFinite(usedPercent) ||
    usedPercent < 0 ||
    usedPercent > 100 ||
    !Number.isSafeInteger(windowMinutes) ||
    windowMinutes <= 0 ||
    !Number.isSafeInteger(resetsAt) ||
    resetsAt <= 0
  ) {
    return null;
  }
  return { usedPercent, windowMinutes, resetsAt };
}

async function recentTranscriptCandidates(
  startedAt: number,
): Promise<Array<{ readonly path: string; readonly sessionId: string }>> {
  const root =
    process.env.CODEX_TRANSCRIPT_ROOT ?? path.join(CODEX_HOME, "sessions");
  const dates = [new Date(startedAt), new Date(startedAt - 24 * 60 * 60 * 1_000)];
  const directories = [...new Set(dates.map((date) =>
    path.join(
      root,
      String(date.getUTCFullYear()),
      String(date.getUTCMonth() + 1).padStart(2, "0"),
      String(date.getUTCDate()).padStart(2, "0"),
    )
  ))];
  const candidates: Array<{
    path: string;
    sessionId: string;
    modifiedAt: number;
  }> = [];
  for (const directory of directories) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const match =
        /-([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/iu.exec(entry.name);
      if (!match) continue;
      const candidatePath = path.join(directory, entry.name);
      const fileStat = await statFile(candidatePath).catch(() => null);
      if (
        !fileStat?.isFile() ||
        fileStat.mtimeMs < startedAt - 60_000
      ) {
        continue;
      }
      candidates.push({
        path: candidatePath,
        sessionId: match[1],
        modifiedAt: fileStat.mtimeMs,
      });
    }
  }
  return candidates
    .sort((left, right) => right.modifiedAt - left.modifiedAt)
    .slice(0, 12)
    .map(({ path: candidatePath, sessionId }) => ({
      path: candidatePath,
      sessionId,
    }));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

function isCodexGoalStatus(value: unknown): value is AppServerGoalStatus {
  return value === "active" ||
    value === "paused" ||
    value === "blocked" ||
    value === "usageLimited" ||
    value === "budgetLimited" ||
    value === "complete";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
