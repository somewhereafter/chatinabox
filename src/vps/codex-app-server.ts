import {
  type ChildProcessWithoutNullStreams,
  spawn,
} from "node:child_process";

const APP_SERVER_REQUEST_TIMEOUT_MS = 12_000;
const APP_SERVER_EXIT_TIMEOUT_MS = 1_000;
const APP_SERVER_ARGS = [
  "-c",
  "mcp_servers.interactive-shell.enabled=false",
  "-c",
  "mcp_servers.mimic-local.enabled=false",
  "-c",
  "mcp_servers.openaiDeveloperDocs.enabled=false",
  "app-server",
] as const;
const GOAL_STATUSES = new Set<CodexGoalStatus>([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
]);

export type CodexGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";

export interface CodexThreadGoal {
  readonly threadId: string;
  readonly objective: string;
  readonly status: CodexGoalStatus;
  readonly tokenBudget: number | null;
  readonly tokensUsed: number;
  readonly timeUsedSeconds: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CodexGoalThread {
  readonly threadId: string;
  readonly cwd?: string;
}

export interface CodexGoalUpdate {
  readonly objective?: string;
  readonly status?: CodexGoalStatus;
  readonly tokenBudget?: number | null;
}

export interface CodexGoalObservation extends CodexGoalThread {
  readonly goal: CodexThreadGoal | null;
  readonly error?: string;
}

/**
 * A deliberately short-lived app-server client. Codex owns persisted thread
 * state; starting a fresh process for each batch prevents a sidecar from
 * becoming a second, stale owner of a terminal-driven thread.
 */
export class CodexAppServerGoalClient {
  constructor(
    private readonly codexPath =
      process.env.CHATINABOX_CODEX_PATH?.trim() || "codex",
  ) {}

  async getGoals(
    threads: readonly CodexGoalThread[],
  ): Promise<CodexGoalObservation[]> {
    if (threads.length === 0) return [];
    return this.withConnection(async (connection) => {
      const observations: CodexGoalObservation[] = [];
      for (const thread of threads) {
        try {
          await connection.request("thread/resume", {
            threadId: thread.threadId,
            ...(thread.cwd ? { cwd: thread.cwd } : {}),
          });
          const response = await connection.request("thread/goal/get", {
            threadId: thread.threadId,
          });
          const record = plainRecord(response);
          observations.push({
            ...thread,
            goal: parseCodexThreadGoal(record?.goal),
          });
        } catch (error) {
          observations.push({
            ...thread,
            goal: null,
            error: errorMessage(error),
          });
        }
      }
      return observations;
    });
  }

  async setGoal(
    thread: CodexGoalThread,
    update: CodexGoalUpdate,
  ): Promise<CodexThreadGoal> {
    if (
      update.objective === undefined &&
      update.status === undefined &&
      update.tokenBudget === undefined
    ) {
      throw new Error("A goal update must change at least one field");
    }
    return this.withConnection(async (connection) => {
      await connection.request("thread/resume", {
        threadId: thread.threadId,
        ...(thread.cwd ? { cwd: thread.cwd } : {}),
      });
      const response = await connection.request("thread/goal/set", {
        threadId: thread.threadId,
        ...update,
      });
      const goal = parseCodexThreadGoal(plainRecord(response)?.goal);
      if (!goal) throw new Error("Codex returned an invalid goal");
      return goal;
    });
  }

  async clearGoal(thread: CodexGoalThread): Promise<void> {
    await this.withConnection(async (connection) => {
      await connection.request("thread/resume", {
        threadId: thread.threadId,
        ...(thread.cwd ? { cwd: thread.cwd } : {}),
      });
      await connection.request("thread/goal/clear", {
        threadId: thread.threadId,
      });
    });
  }

  private async withConnection<T>(
    work: (connection: AppServerConnection) => Promise<T>,
  ): Promise<T> {
    const child = spawn(
      this.codexPath,
      APP_SERVER_ARGS,
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
        detached: process.platform !== "win32",
      },
    );
    const connection = new AppServerConnection(child);
    try {
      await connection.initialize();
      return await work(connection);
    } finally {
      await connection.close();
    }
  }
}

class AppServerConnection {
  private nextId = 1;
  private stdoutBuffer = "";
  private stderr = "";
  private closed = false;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4_000);
    });
    child.once("error", (error) => this.failAll(error));
    child.once("exit", (code, signal) => {
      if (this.closed) return;
      const detail = this.stderr.trim();
      this.failAll(
        new Error(
          `Codex app-server exited (${code ?? signal ?? "unknown"})` +
            (detail ? `: ${detail}` : ""),
        ),
      );
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "chatinabox",
        title: "Chatinabox goal sync",
        version: "1",
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
        optOutNotificationMethods: [],
      },
    });
    this.write({ method: "initialized", params: {} });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error("Codex app-server is closed"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server timed out during ${method}`));
      }, APP_SERVER_REQUEST_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error("Codex app-server connection closed"));
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.killChildTree("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this.child.exitCode === null && this.child.signalCode === null) {
          this.killChildTree("SIGKILL");
        }
        resolve();
      }, APP_SERVER_EXIT_TIMEOUT_MS);
      timer.unref();
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private killChildTree(signal: NodeJS.Signals): void {
    if (process.platform !== "win32" && this.child.pid) {
      try {
        process.kill(-this.child.pid, signal);
        return;
      } catch {
        // Fall through when the process group has already exited.
      }
    }
    this.child.kill(signal);
  }

  private write(value: unknown): void {
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const record = plainRecord(parsed);
      const id = record?.id;
      if (
        !record ||
        !Number.isSafeInteger(id) ||
        typeof record.method === "string" ||
        (!("result" in record) && !("error" in record))
      ) continue;
      const pending = this.pending.get(Number(id));
      if (!pending) continue;
      this.pending.delete(Number(id));
      clearTimeout(pending.timer);
      const rpcError = plainRecord(record?.error);
      if (rpcError) {
        pending.reject(
          new Error(
            typeof rpcError.message === "string"
              ? rpcError.message
              : "Codex app-server request failed",
          ),
        );
      } else {
        pending.resolve(record?.result);
      }
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function parseCodexThreadGoal(value: unknown): CodexThreadGoal | null {
  const record = plainRecord(value);
  if (
    !record ||
    typeof record.threadId !== "string" ||
    record.threadId.trim().length === 0 ||
    typeof record.objective !== "string" ||
    !GOAL_STATUSES.has(record.status as CodexGoalStatus) ||
    !nonNegativeInteger(record.tokensUsed) ||
    !nonNegativeInteger(record.timeUsedSeconds) ||
    !nonNegativeInteger(record.createdAt) ||
    !nonNegativeInteger(record.updatedAt) ||
    !validTokenBudget(record.tokenBudget)
  ) {
    return null;
  }
  return {
    threadId: record.threadId,
    objective: record.objective,
    status: record.status as CodexGoalStatus,
    tokenBudget:
      record.tokenBudget === null ? null : Number(record.tokenBudget),
    tokensUsed: Number(record.tokensUsed),
    timeUsedSeconds: Number(record.timeUsedSeconds),
    createdAt: Number(record.createdAt),
    updatedAt: Number(record.updatedAt),
  };
}

function nonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validTokenBudget(value: unknown): boolean {
  return value === null ||
    (Number.isSafeInteger(value) && Number(value) > 0);
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
