import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export type WorkerModel = "sol" | "luna" | "terra";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface ExperienceProfile {
  readonly version: 1;
  readonly setupComplete: boolean;
  readonly assistant: {
    readonly name: string;
    readonly mark: string;
  };
  readonly overview: {
    readonly name: string;
    readonly emoji: string;
  };
  readonly manager: {
    readonly name: string;
    readonly emoji: string;
    readonly role: string;
    readonly topicName: string;
    readonly topicIconEmoji: string;
    readonly cwd: string;
    readonly model: WorkerModel;
    readonly reasoningEffort: ReasoningEffort;
    readonly fast: boolean;
  };
  readonly sessions: {
    readonly defaultModel: WorkerModel;
    readonly defaultReasoningEffort: ReasoningEffort;
    readonly defaultFast: boolean;
    readonly idleCloseMinutes: number;
    readonly workingIconEmoji: string;
    readonly doneIconEmoji: string;
    readonly closedIconEmoji: string;
  };
}

export interface ExperienceProfilePatch {
  readonly setupComplete?: boolean;
  readonly assistant?: Partial<ExperienceProfile["assistant"]>;
  readonly overview?: Partial<ExperienceProfile["overview"]>;
  readonly manager?: Partial<ExperienceProfile["manager"]>;
  readonly sessions?: Partial<ExperienceProfile["sessions"]>;
}

export const DEFAULT_EXPERIENCE_PROFILE: ExperienceProfile = {
  version: 1,
  setupComplete: false,
  assistant: {
    name: "codex",
    mark: "⌁",
  },
  overview: {
    name: "overview",
    emoji: "◉",
  },
  manager: {
    name: "orchestrator",
    emoji: "🪄",
    role: "orchestrator",
    topicName: "🪄 orchestrator",
    topicIconEmoji: "🔮",
    cwd: "/var/lib/chatinabox-bridge/manager",
    model: "terra",
    reasoningEffort: "medium",
    fast: false,
  },
  sessions: {
    defaultModel: "sol",
    defaultReasoningEffort: "high",
    defaultFast: false,
    idleCloseMinutes: 30,
    workingIconEmoji: "🧪",
    doneIconEmoji: "✅",
    closedIconEmoji: "📁",
  },
};

export class ExperienceProfileProvider {
  private signature = "";
  private cached = DEFAULT_EXPERIENCE_PROFILE;

  constructor(private readonly profilePath: string) {}

  current(): ExperienceProfile {
    let signature: string;
    try {
      const stat = statSync(this.profilePath);
      signature = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return DEFAULT_EXPERIENCE_PROFILE;
    }
    if (signature === this.signature) return this.cached;
    this.cached = readExperienceProfile(this.profilePath);
    this.signature = signature;
    return this.cached;
  }
}

export function readExperienceProfile(profilePath: string): ExperienceProfile {
  try {
    return normalizeExperienceProfile(
      JSON.parse(readFileSync(profilePath, "utf8")) as unknown,
    );
  } catch {
    return DEFAULT_EXPERIENCE_PROFILE;
  }
}

export function writeExperienceProfile(
  profilePath: string,
  profile: ExperienceProfile,
): ExperienceProfile {
  const normalized = normalizeExperienceProfile(profile);
  mkdirSync(path.dirname(profilePath), { recursive: true, mode: 0o755 });
  const temporary = `${profilePath}.${process.pid}.tmp`;
  writeFileSync(
    temporary,
    `${JSON.stringify(normalized, null, 2)}\n`,
    { encoding: "utf8", mode: 0o644 },
  );
  chmodSync(temporary, 0o644);
  renameSync(temporary, profilePath);
  return normalized;
}

export function patchExperienceProfile(
  current: ExperienceProfile,
  patch: ExperienceProfilePatch,
): ExperienceProfile {
  return normalizeExperienceProfile({
    ...current,
    ...(patch.setupComplete !== undefined
      ? { setupComplete: patch.setupComplete }
      : {}),
    assistant: { ...current.assistant, ...patch.assistant },
    overview: { ...current.overview, ...patch.overview },
    manager: { ...current.manager, ...patch.manager },
    sessions: { ...current.sessions, ...patch.sessions },
  });
}

export function normalizeExperienceProfile(
  value: unknown,
): ExperienceProfile {
  const root = record(value);
  const assistant = record(root.assistant);
  const overview = record(root.overview);
  const manager = record(root.manager);
  const sessions = record(root.sessions);
  return {
    version: 1,
    setupComplete: boolean(root.setupComplete, false),
    assistant: {
      name: text(assistant.name, "codex", 1, 32),
      mark: text(assistant.mark, "⌁", 0, 16),
    },
    overview: {
      name: text(overview.name, "overview", 1, 32),
      emoji: text(overview.emoji, "◉", 0, 8),
    },
    manager: {
      name: text(manager.name, "orchestrator", 1, 32),
      emoji: text(manager.emoji, "🪄", 0, 8),
      role: text(manager.role, "orchestrator", 1, 48),
      topicName: text(manager.topicName, "🪄 orchestrator", 1, 128),
      topicIconEmoji: text(manager.topicIconEmoji, "🔮", 1, 8),
      cwd: managerWorkspace(
        manager.cwd,
        "/var/lib/chatinabox-bridge/manager",
      ),
      model: workerModel(manager.model, "terra"),
      reasoningEffort: reasoningEffort(manager.reasoningEffort, "medium"),
      fast: boolean(manager.fast, false),
    },
    sessions: {
      defaultModel: workerModel(sessions.defaultModel, "sol"),
      defaultReasoningEffort: reasoningEffort(
        sessions.defaultReasoningEffort,
        "high",
      ),
      defaultFast: boolean(sessions.defaultFast, false),
      idleCloseMinutes: integer(sessions.idleCloseMinutes, 30, 0, 10_080),
      workingIconEmoji: text(sessions.workingIconEmoji, "🧪", 1, 8),
      doneIconEmoji: text(sessions.doneIconEmoji, "✅", 1, 8),
      closedIconEmoji: text(sessions.closedIconEmoji, "📁", 1, 8),
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(
  value: unknown,
  fallback: string,
  minimum: number,
  maximum: number,
): string {
  if (typeof value !== "string") return fallback;
  const normalized = value
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const length = [...normalized].length;
  return length >= minimum && length <= maximum ? normalized : fallback;
}

function managerWorkspace(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.length > 1_024) return fallback;
  const normalized = path.posix.normalize(value.trim());
  return normalized.startsWith("/var/lib/chatinabox-bridge/") &&
      normalized !== "/var/lib/chatinabox-bridge/"
    ? normalized
    : fallback;
}

function workerModel(value: unknown, fallback: WorkerModel): WorkerModel {
  return value === "sol" || value === "luna" || value === "terra"
    ? value
    : fallback;
}

function reasoningEffort(
  value: unknown,
  fallback: ReasoningEffort,
): ReasoningEffort {
  return value === "low" ||
      value === "medium" ||
      value === "high" ||
      value === "xhigh"
    ? value
    : fallback;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function integer(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Number.isSafeInteger(value) &&
      Number(value) >= minimum &&
      Number(value) <= maximum
    ? Number(value)
    : fallback;
}
