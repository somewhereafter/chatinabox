export const DEFAULT_CODEX_BRIDGE_SOCKET =
  "/run/catinabox/bridge.sock";
export const CATINABOX_LOBBY_NAME = "🪄 Lobby";
export const DEFAULT_CATINABOX_LOBBY_CWD =
  "/var/lib/catinabox-bridge/lobby";

export interface CodexPaneIdentity {
  readonly serverPid: number;
  readonly paneId: string;
  readonly panePid: number;
}

export type CodexAssistantName =
  | "Sol"
  | "Luna"
  | "Terra"
  | "Lobby"
  | "Codex";

export interface CodexPane extends CodexPaneIdentity {
  readonly sessionName: string;
  readonly windowName: string;
  readonly windowIndex: number;
  readonly cwd: string;
  readonly active: boolean;
  readonly busy: boolean;
  readonly codexPid: number;
  readonly assistantName?: CodexAssistantName;
  readonly sessionId?: string;
}

export type CodexEventKind =
  | "assistant_final"
  | "assistant_progress"
  | "context_compacted"
  | "image_viewed"
  | "session_renamed"
  | "session_handoff"
  | "user_local"
  | "state_compacting"
  | "state_working"
  | "state_waiting_terminal"
  | "state_activity";

export interface CodexEvent {
  readonly id: number;
  readonly kind: CodexEventKind;
  readonly target: CodexPaneIdentity;
  readonly sessionId: string;
  readonly turnId: string;
  readonly assistantName: CodexAssistantName;
  readonly message: string;
  readonly createdAt: number;
}

export interface CodexRecentSession {
  readonly id: string;
  readonly name: string;
  readonly updatedAt: string;
}

export type CodexBridgeRequest =
  | { readonly op: "ping" }
  | { readonly op: "list" }
  | {
      readonly op: "send";
      readonly target: CodexPaneIdentity;
      readonly text: string;
    }
  | { readonly op: "interrupt"; readonly target: CodexPaneIdentity }
  | {
      readonly op: "keys";
      readonly target: CodexPaneIdentity;
      readonly keys: readonly string[];
    }
  | { readonly op: "screen"; readonly target: CodexPaneIdentity }
  | {
      readonly op: "new";
      readonly name?: string;
      readonly cwd?: string;
      readonly tmuxSession?: string;
      readonly model?: "sol" | "luna" | "terra";
      readonly reasoningEffort?: "low" | "medium" | "high";
      readonly fast?: boolean;
    }
  | {
      readonly op: "resume";
      readonly sessionId: string;
      readonly name?: string;
      readonly tmuxSession?: string;
    }
  | {
      readonly op: "rename";
      readonly target: CodexPaneIdentity;
      readonly name: string;
    }
  | {
      readonly op: "renameSelf";
      readonly target: CodexPaneIdentity;
      readonly name: string;
    }
  | { readonly op: "lobby" }
  | {
      readonly op: "handoff";
      readonly source: CodexPaneIdentity;
      readonly destination: CodexPaneIdentity;
    }
  | {
      readonly op: "bind";
      readonly target: CodexPaneIdentity;
      readonly sessionId: string;
      readonly transcriptPath: string;
    }
  | { readonly op: "events"; readonly limit?: number }
  | { readonly op: "ack"; readonly eventId: number }
  | {
      readonly op: "hook";
      readonly paneId: string;
      readonly payload: Record<string, unknown>;
    };

export type CodexBridgeResponse =
  | { readonly ok: true; readonly pong: true }
  | {
      readonly ok: true;
      readonly panes: readonly CodexPane[];
      readonly recent: readonly CodexRecentSession[];
    }
  | { readonly ok: true; readonly pane: CodexPane }
  | {
      readonly ok: true;
      readonly sent: true;
      readonly queuedUntilNextToolCall: boolean;
    }
  | { readonly ok: true; readonly interrupted: true }
  | { readonly ok: true; readonly keysSent: true }
  | {
      readonly ok: true;
      readonly screen: {
        readonly imageBase64: string;
        readonly width: number;
        readonly height: number;
        readonly capturedAt: number;
      };
    }
  | { readonly ok: true; readonly renamed: true; readonly pane: CodexPane }
  | {
      readonly ok: true;
      readonly handoffQueued: true;
      readonly destination: CodexPane;
    }
  | { readonly ok: true; readonly events: readonly CodexEvent[] }
  | { readonly ok: true; readonly acked: boolean }
  | { readonly ok: true; readonly accepted: boolean }
  | { readonly ok: false; readonly error: string; readonly code: string };

export function isPaneIdentity(value: unknown): value is CodexPaneIdentity {
  if (!isPlainRecord(value)) return false;
  return (
    Number.isSafeInteger(value.serverPid) &&
    Number(value.serverPid) > 0 &&
    typeof value.paneId === "string" &&
    /^%\d{1,10}$/u.test(value.paneId) &&
    Number.isSafeInteger(value.panePid) &&
    Number(value.panePid) > 0
  );
}

export function samePaneIdentity(
  left: CodexPaneIdentity,
  right: CodexPaneIdentity,
): boolean {
  return (
    left.serverPid === right.serverPid &&
    left.paneId === right.paneId &&
    left.panePid === right.panePid
  );
}

export function assistantNameForModel(model: unknown): CodexAssistantName {
  if (typeof model !== "string") return "Codex";
  const normalized = model.toLowerCase();
  if (/(?:^|[-_.])sol(?:$|[-_.])/u.test(normalized)) return "Sol";
  if (/(?:^|[-_.])luna(?:$|[-_.])/u.test(normalized)) return "Luna";
  if (/(?:^|[-_.])terra(?:$|[-_.])/u.test(normalized)) return "Terra";
  return "Codex";
}

export function normalizeAssistantName(value: unknown): CodexAssistantName {
  return value === "Sol" ||
      value === "Luna" ||
      value === "Terra" ||
      value === "Lobby"
    ? value
    : "Codex";
}

export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
