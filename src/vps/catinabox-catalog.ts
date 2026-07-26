import type {
  CodexPane,
  CodexPaneIdentity,
  CodexRecentSession,
} from "./codex-bridge-protocol";
import { samePaneIdentity } from "./codex-bridge-protocol";

export interface CatinaboxCatalogPane {
  readonly selector: string;
  readonly name: string;
  readonly role?: "lobby" | "worker";
  readonly model?: string;
  readonly status: "working" | "ready";
  readonly cwd?: string;
}

export interface CatinaboxCatalog {
  readonly ok: true;
  readonly attached: CatinaboxCatalogPane | null;
  readonly workers: readonly CatinaboxCatalogPane[];
  readonly lobby: CatinaboxCatalogPane | null;
  readonly recent: readonly {
    readonly sessionId: string;
    readonly name: string;
    readonly updatedAt: string;
  }[];
}

export function buildCatinaboxCatalog(
  panes: readonly CodexPane[],
  recent: readonly CodexRecentSession[],
  attachedTarget: CodexPaneIdentity | null,
): CatinaboxCatalog {
  const attached = attachedTarget
    ? panes.find((pane) => samePaneIdentity(pane, attachedTarget))
    : undefined;
  const lobby = panes.find((pane) => pane.assistantName === "Lobby");
  const runningSessionIds = new Set(
    panes.flatMap((pane) => pane.sessionId ? [pane.sessionId] : []),
  );

  return {
    ok: true,
    attached: attached
      ? {
          selector: attached.paneId,
          name: attached.windowName,
          role: attached.assistantName === "Lobby" ? "lobby" : "worker",
          model: attached.assistantName ?? "Codex",
          status: attached.busy ? "working" : "ready",
          cwd: attached.cwd,
        }
      : null,
    workers: panes
      .filter((pane) => pane.assistantName !== "Lobby")
      .map((pane) => ({
        selector: pane.paneId,
        name: pane.windowName,
        model: pane.assistantName ?? "Codex",
        status: pane.busy ? "working" : "ready",
        cwd: pane.cwd,
      })),
    lobby: lobby
      ? {
          selector: lobby.paneId,
          name: lobby.windowName,
          status: lobby.busy ? "working" : "ready",
        }
      : null,
    recent: recent
      .filter((session) => !runningSessionIds.has(session.id))
      .map((session) => ({
        sessionId: session.id,
        name: session.name,
        updatedAt: session.updatedAt,
      })),
  };
}
