import {
  buildInlineKeyboard,
  issueCallbackReference,
  MAX_CALLBACK_TTL_MS,
  parseCallbackReference,
} from "../telegram-callback";
import {
  tgAnswerCallbackQuery,
  tgEditRichHtml,
  tgSend,
  tgSendRichHtml,
  escapeTelegramHtml,
} from "../telegram";
import type {
  TelegramCallbackQuery,
  TelegramMessage,
} from "../telegram-types";
import {
  type CodexBridgeResponse,
  type CodexUsage,
  type CodexUsageLimit,
} from "./codex-bridge-protocol";
import { CodexBridgeClient } from "./codex-bridge-client";
import type { ChatinaboxEnv } from "./env";
import {
  DEFAULT_EXPERIENCE_PROFILE,
  type ExperienceProfile,
} from "./experience-profile";
import { abortableSleep } from "./sleep";
import type {
  ChatinaboxStore,
  CodexGoalHistoryRow,
  CodexGoalRow,
  OverviewDashboardRow,
} from "./store";

const NEXUS_POLL_MS = 5_000;
const NEXUS_TIMESTAMP_REFRESH_MS = 60_000;

type BridgeClient = Pick<CodexBridgeClient, "request">;

export interface OverviewStats {
  readonly total: number;
  readonly active: number;
  readonly working: number;
  readonly idle: number;
  readonly bridgeOnline: boolean;
  readonly usage: CodexUsage | null;
}

export interface OverviewGoals {
  readonly current: readonly (CodexGoalRow & {
    readonly topic_name?: string;
  })[];
  readonly recent: readonly CodexGoalHistoryRow[];
}

interface OverviewDependencies {
  readonly env: ChatinaboxEnv;
  readonly store: ChatinaboxStore;
  readonly bridge?: BridgeClient;
  readonly now?: () => number;
  readonly profile?: () => ExperienceProfile;
}

export class OverviewController {
  private readonly bridge: BridgeClient;
  private readonly now: () => number;
  private readonly profile: () => ExperienceProfile;
  private readonly refreshing = new Map<number, Promise<void>>();

  constructor(private readonly dependencies: OverviewDependencies) {
    this.bridge =
      dependencies.bridge ??
      new CodexBridgeClient(dependencies.env.CODEX_BRIDGE_SOCKET);
    this.now = dependencies.now ?? Date.now;
    this.profile = dependencies.profile ?? (() => DEFAULT_EXPERIENCE_PROFILE);
  }

  isOverviewChat(chatId: number): boolean {
    return this.dependencies.store.isOverviewChat(chatId);
  }

  isOverviewMessage(
    message: Pick<TelegramMessage, "chat" | "message_thread_id">,
  ): boolean {
    const row = this.dependencies.store.overviewDashboard(message.chat.id);
    return row !== null &&
      row.message_thread_id === overviewThreadId(message);
  }

  async handleCommand(
    message: TelegramMessage,
    command: { readonly name: string; readonly argument: string },
  ): Promise<boolean> {
    if (command.name !== "nexus" && command.name !== "overview") return false;
    const chatId = message.chat.id;
    const ownerUserId = message.from?.id;
    if (
      !Number.isSafeInteger(chatId) ||
      !Number.isSafeInteger(ownerUserId) ||
      ownerUserId! <= 0
    ) {
      return true;
    }
    if (chatId >= 0) {
      const overview = this.profile().overview;
      await tgSend(
        this.dependencies.env,
        chatId,
        `${escapeTelegramHtml(overview.emoji)} Run ` +
          `<code>/overview setup</code> inside the ` +
          `${escapeTelegramHtml(overview.name)} forum topic.`,
        message.message_id,
      );
      return true;
    }
    const subcommand = command.argument.trim().toLowerCase();
    if (subcommand && subcommand !== "setup" && subcommand !== "refresh") {
      await tgSend(
        this.dependencies.env,
        chatId,
        "Use <code>/overview setup</code> or <code>/overview refresh</code>.",
        message.message_id,
      );
      return true;
    }
    if (subcommand === "refresh") {
      if (!this.isOverviewChat(chatId)) {
        await tgSend(
          this.dependencies.env,
          chatId,
          "Start this dashboard with <code>/overview setup</code>.",
          message.message_id,
        );
        return true;
      }
      await this.refresh(chatId, true);
      return true;
    }

    const threadId = overviewThreadId(message);
    // The overview is deliberately never a conversational Codex route.
    this.dependencies.store.detachCodex(chatId, ownerUserId!);
    this.dependencies.store.registerOverview(chatId, ownerUserId!, threadId);
    await this.refresh(chatId, true);
    return true;
  }

  async handleCallback(callback: TelegramCallbackQuery): Promise<boolean> {
    const chatId = callback.message?.chat.id;
    const ownerUserId = callback.from.id;
    if (
      !Number.isSafeInteger(chatId) ||
      !Number.isSafeInteger(ownerUserId) ||
      typeof callback.data !== "string"
    ) {
      return false;
    }
    const registered = this.isOverviewChat(chatId!);
    const parsed = await parseCallbackReference(
      this.dependencies.store.callbackStore(),
      callback.data,
      { chatId: chatId!, userId: ownerUserId },
    );
    if (!parsed.ok) {
      if (!registered) return false;
      await tgAnswerCallbackQuery(this.dependencies.env, callback.id, {
        text: "This button expired. Send /overview refresh.",
        showAlert: true,
        cacheTime: 0,
      }).catch(() => undefined);
      return true;
    }
    if (parsed.value.action !== "nexus.refresh") return false;
      await tgAnswerCallbackQuery(this.dependencies.env, callback.id, {
        text: `${this.profile().overview.name} refreshed`,
      cacheTime: 0,
    }).catch(() => undefined);
    await this.refresh(chatId!, true);
    return true;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await Promise.all(
        this.dependencies.store.overviewDashboards().map((row) =>
          this.refresh(row.chat_id, false).catch(() => undefined)
        ),
      );
      await abortableSleep(NEXUS_POLL_MS, signal).catch(() => undefined);
    }
  }

  private refresh(chatId: number, force: boolean): Promise<void> {
    const active = this.refreshing.get(chatId);
    if (active) return active;
    const pending = this.refreshDashboard(chatId, force).finally(() => {
      this.refreshing.delete(chatId);
    });
    this.refreshing.set(chatId, pending);
    return pending;
  }

  private async refreshDashboard(chatId: number, force: boolean): Promise<void> {
    const row = this.dependencies.store.overviewDashboard(chatId);
    if (!row) return;
    const response = await this.bridge.request({ op: "list" }).catch(() => null);
    const stats = overviewStatsFromBridge(response);
    const goals: OverviewGoals = {
      current: this.dependencies.store.codexGoalsForChat(chatId)
        .filter((goal) => goal.status !== "complete")
        .map((goal) => {
          const topicName = this.dependencies.store.topicSetup(
            goal.chat_id,
            goal.owner_user_id,
            goal.message_thread_id,
          )?.topic_name;
          return {
            ...goal,
            ...(topicName ? { topic_name: topicName } : {}),
          };
        }),
      recent: this.dependencies.store.recentCompletedCodexGoals(chatId, 10),
    };
    const profile = this.profile();
    const signature = overviewRenderSignature(stats, profile, goals);
    const timestampDue =
      this.now() - row.rendered_at >= NEXUS_TIMESTAMP_REFRESH_MS;
    if (
      row.dashboard_message_id !== null &&
      row.render_signature === signature &&
      !force &&
      !timestampDue
    ) {
      return;
    }
    const refreshButton = (
      await issueCallbackReference(this.dependencies.store.callbackStore(), {
        action: "nexus.refresh",
        chatId,
        userId: row.owner_user_id,
        payload: {},
        ttlMs: MAX_CALLBACK_TTL_MS,
        now: this.now(),
      })
    ).callbackData;
    const keyboard = buildInlineKeyboard([
      [{ label: "↻  refresh", callbackData: refreshButton }],
    ]);
    const text = formatOverviewDashboard(stats, this.now(), profile, goals);
    if (row.dashboard_message_id !== null) {
      const edited = await tgEditRichHtml(
        this.dependencies.env,
        chatId,
        row.dashboard_message_id,
        text,
        keyboard,
      );
      if (edited.ok) {
        this.dependencies.store.setOverviewDashboardMessage(
          chatId,
          row.dashboard_message_id,
          signature,
        );
        return;
      }
    }
    await this.sendReplacement(row, text, signature, keyboard);
  }

  private async sendReplacement(
    row: OverviewDashboardRow,
    text: string,
    signature: string,
    keyboard: ReturnType<typeof buildInlineKeyboard>,
  ): Promise<void> {
    const sent = await tgSendRichHtml(
      this.dependencies.env,
      row.chat_id,
      text,
      undefined,
      keyboard,
      row.message_thread_id,
    );
    if (!sent.ok || !Number.isSafeInteger(sent.result?.message_id)) {
      throw new Error("Telegram could not create the overview dashboard.");
    }
    this.dependencies.store.setOverviewDashboardMessage(
      row.chat_id,
      sent.result.message_id,
      signature,
    );
  }
}

/**
 * Telegram omits message_thread_id for a forum's General topic. Persist zero
 * as the local sentinel so tgSend omits the field instead of guessing topic 1,
 * which Telegram rejects with "message thread not found".
 */
export function overviewThreadId(
  message: Pick<TelegramMessage, "message_thread_id">,
): number {
  return Number.isSafeInteger(message.message_thread_id) &&
    message.message_thread_id! > 0
    ? message.message_thread_id!
    : 0;
}

export function overviewStatsFromBridge(
  response: CodexBridgeResponse | null,
): OverviewStats {
  if (!response?.ok || !("panes" in response)) {
    return {
      total: 0,
      active: 0,
      working: 0,
      idle: 0,
      bridgeOnline: false,
      usage: null,
    };
  }
  const workers = response.panes.filter(
    (pane) =>
      pane.assistantName !== "Lobby" &&
      pane.windowName !== "🪄 Lobby",
  );
  const working = workers.filter((pane) => pane.busy).length;
  const idle = workers.length - working;
  return {
    total: Math.max(response.totalSessions, workers.length),
    active: workers.length,
    working,
    idle,
    bridgeOnline: true,
    usage: response.usage,
  };
}

export function overviewRenderSignature(
  stats: OverviewStats,
  profile: ExperienceProfile = DEFAULT_EXPERIENCE_PROFILE,
  goals: OverviewGoals = { current: [], recent: [] },
): string {
  return JSON.stringify({
    total: stats.total,
    active: stats.active,
    working: stats.working,
    idle: stats.idle,
    bridgeOnline: stats.bridgeOnline,
    overview: profile.overview,
    goals: {
      current: goals.current.map((goal) => ({
        threadId: goal.thread_id,
        objective: goal.objective,
        status: goal.status,
        tokenBudget: goal.token_budget,
        tokensUsed: goal.tokens_used,
        timeUsedSeconds: goal.time_used_seconds,
        updatedAt: goal.goal_updated_at,
      })),
      recent: goals.recent.map((goal) => ({
        id: goal.id,
        objective: goal.objective,
        topicName: goal.topic_name,
        tokensUsed: goal.tokens_used,
        timeUsedSeconds: goal.time_used_seconds,
        completedAt: goal.completed_at,
      })),
    },
    usage: stats.usage
      ? {
          creditsBalance: stats.usage.creditsBalance,
          limits: stats.usage.limits,
        }
      : null,
  });
}

export function formatOverviewDashboard(
  stats: OverviewStats,
  refreshedAt: number = Date.now(),
  profile: ExperienceProfile = DEFAULT_EXPERIENCE_PROFILE,
  goals: OverviewGoals = { current: [], recent: [] },
): string {
  const status = stats.bridgeOnline
    ? "🟢 live"
    : "🔴 offline";
  const sessions =
    `<blockquote>` +
    `🗂 <b>${stats.total}</b> total<br/>` +
    `🟢 <b>${stats.active}</b> active<br/>` +
    `⚡ <b>${stats.working}</b> working<br/>` +
    `💤 <b>${stats.idle}</b> idle` +
    `</blockquote>`;
  const usage = formatUsage(stats.usage);
  const goalState = formatOverviewGoals(goals);
  return (
    `<mark>${escapeTelegramHtml(profile.overview.name)} ` +
    `${escapeTelegramHtml(profile.overview.emoji)} · ${status}</mark>\n\n` +
    `<p><b>sessions</b></p>${sessions}\n\n` +
    `<p><b>goals</b></p>${goalState}\n\n` +
    `<p><b>usage limits</b></p>${usage}\n\n` +
    `<footer>synced ${formatUtcDate(refreshedAt)}</footer>`
  );
}

function formatOverviewGoals(goals: OverviewGoals): string {
  const current = goals.current.length === 0
    ? "<blockquote>no active or paused goals</blockquote>"
    : goals.current.slice(0, 10).map((goal) => {
      const setupName = goal.topic_name || (
        goal.message_thread_id > 0
          ? `topic ${goal.message_thread_id}`
          : "direct chat"
      );
      return (
        `<blockquote><b>🎯 ${escapeTelegramHtml(
          overviewGoalStatus(goal.status),
        )}</b> · ${escapeTelegramHtml(setupName)}` +
        `<br/>${escapeTelegramHtml(shortGoalText(goal.objective))}` +
        `<br/><i>${formatGoalUsage(
          goal.tokens_used,
          goal.time_used_seconds,
          goal.token_budget,
        )}</i></blockquote>`
      );
    }).join("");
  if (goals.recent.length === 0) return current;
  const recent = goals.recent.map((goal) => {
    const origin = goal.topic_name || (
      goal.message_thread_id > 0
        ? `topic ${goal.message_thread_id}`
        : "direct chat"
    );
    return (
      `<p><b>✓ ${escapeTelegramHtml(origin)}</b><br/>` +
      `${escapeTelegramHtml(shortGoalText(goal.objective))}<br/>` +
      `<i>${formatGoalUsage(
        goal.tokens_used,
        goal.time_used_seconds,
        null,
      )} · ${formatUtcDate(goal.completed_at)}</i></p>`
    );
  }).join("");
  return (
    `${current}<details><summary>recent completed goals</summary>` +
    `${recent}</details>`
  );
}

function overviewGoalStatus(status: CodexGoalRow["status"]): string {
  if (status === "usageLimited") return "usage limited";
  if (status === "budgetLimited") return "budget reached";
  return status;
}

function shortGoalText(value: string): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length <= 180 ? compact : `${compact.slice(0, 179)}…`;
}

function formatGoalUsage(
  tokensUsed: number,
  timeUsedSeconds: number,
  tokenBudget: number | null,
): string {
  const tokens = tokenBudget === null
    ? `${tokensUsed.toLocaleString("en-US")} tokens`
    : `${tokensUsed.toLocaleString("en-US")} / ` +
      `${tokenBudget.toLocaleString("en-US")} tokens`;
  return `${tokens} · ${formatCompactSeconds(timeUsedSeconds)}`;
}

function formatCompactSeconds(value: number): string {
  const seconds = Math.max(0, Math.floor(value));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder > 0 ? `${hours}h ${remainder}m` : `${hours}h`;
}

function formatUsage(usage: CodexUsage | null): string {
  if (!usage || usage.limits.length === 0) {
    return "<blockquote>usage telemetry unavailable</blockquote>";
  }
  const limits = usage.limits
    .map((limit) => {
      const remaining = Math.max(0, Math.min(100, 100 - limit.usedPercent));
      const cells = Math.round(remaining / 10);
      const bar = "▰".repeat(cells) + "▱".repeat(10 - cells);
      return (
        `<b>${usageWindowLabel(limit)}</b><br/>` +
        `<code>${bar}</code><br/>` +
        `<b>${formatPercent(remaining)}% remaining</b><br/>` +
        `↻ resets ${formatUtcDate(limit.resetsAt * 1_000)}`
      );
    })
    .join("<br/><br/>");
  const credits = usage.creditsBalance
    ? `<br/><br/>💠 <b>${escapeTelegramHtml(usage.creditsBalance)}</b> credits`
    : "";
  return `<blockquote>${limits}${credits}</blockquote>`;
}

function usageWindowLabel(limit: CodexUsageLimit): string {
  if (limit.windowMinutes === 300) return "5 hour";
  if (limit.windowMinutes === 10_080) return "weekly";
  if (limit.windowMinutes % 1_440 === 0) {
    return `${limit.windowMinutes / 1_440} day`;
  }
  if (limit.windowMinutes % 60 === 0) {
    return `${limit.windowMinutes / 60} hour`;
  }
  return `${limit.windowMinutes} min`;
}

function formatPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatUtcDate(timestamp: number): string {
  const date = new Date(timestamp);
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = date.toLocaleString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
  const year = date.getUTCFullYear();
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${day} ${month.toLowerCase()} ${year} · ${hours}:${minutes} utc`;
}
