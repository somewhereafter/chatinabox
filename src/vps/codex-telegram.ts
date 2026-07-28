import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  buildInlineKeyboard,
  issueCallbackReference,
  parseCallbackReference,
  type InlineKeyboardButtonInput,
  type TelegramInlineKeyboardMarkup,
} from "../telegram-callback";
import {
  escapeTelegramHtml,
  tgAnswerCallbackQuery,
  tgCreateForumTopic,
  tgDeleteMessage,
  tgDownloadFile,
  tgEditForumTopic,
  tgEditPhotoMedia,
  tgEditMessage,
  tgEditMessageCaption,
  tgEditRichHtml,
  tgEditRichMarkdown,
  tgGetFile,
  tgPinChatMessage,
  tgSend,
  tgSendPhoto,
  tgSendRichHtml,
  tgSendRichMarkdown,
} from "../telegram";
import type {
  TelegramCallbackQuery,
  TelegramDocument,
  TelegramMessage,
  TelegramPhotoSize,
  TelegramVoice,
} from "../telegram-types";
import { abortableSleep } from "./sleep";
import { CodexBridgeClient } from "./codex-bridge-client";
import {
  CHATINABOX_LOBBY_NAME,
  isPaneIdentity,
  normalizeAssistantName,
  samePaneIdentity,
  type CodexAssistantName,
  type CodexBridgeResponse,
  type CodexPane,
  type CodexPaneIdentity,
  type CodexRecentSession,
  type CodexEvent,
  type CodexThreadGoal,
} from "./codex-bridge-protocol";
import type { ChatinaboxEnv } from "./env";
import {
  DEFAULT_EXPERIENCE_PROFILE,
  type ExperienceProfile,
} from "./experience-profile";
import type {
  CodexAttachmentRow,
  CodexGoalHistoryRow,
  CodexGoalRow,
  CodexPromptRow,
  CodexStatusRow,
  CodexStatusSnapshot,
  CodexThinkingSectionRow,
  ChatinaboxStore,
} from "./store";
import { parseThinkingSummaries } from "./store";
import { transcribeScribeV2 } from "./scribe";
import {
  renderTelegramMarkdownChunks,
} from "./telegram-markdown";
import {
  TelegramProgressPacer,
  type ProgressPacer,
} from "./progress-pacer";

const CODEX_CALLBACK_TTL_MS = 24 * 60 * 60 * 1_000;
const TELEGRAM_SAFE_TEXT_CHARS = 3_400;
const CODEX_ATTACHMENT_MAX_COUNT = 10;
const CODEX_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
const CODEX_ATTACHMENT_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const CODEX_ATTACHMENT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS = 900;
const TELEGRAM_TEXT_BURST_DEBOUNCE_MS = 700;
const THINKING_SECTION_FLUSH_INTERVAL_MS = 10_000;
const GOAL_SYNC_INTERVAL_MS = 30_000;
const TRANSIENT_REFRESH_INTERVAL_MS = 10_000;
const POST_RESPONSE_TRANSIENT_GRACE_MS = 5_000;

interface TopicPresenceSink {
  markWorking(attachment: CodexAttachmentRow): Promise<void>;
  markReady(attachment: CodexAttachmentRow): Promise<void>;
}

interface CodexTelegramDependencies {
  readonly env: ChatinaboxEnv;
  readonly store: ChatinaboxStore;
  readonly bridge?: CodexBridgeClient;
  readonly topicPresence?: TopicPresenceSink;
  readonly profile?: () => ExperienceProfile;
  readonly now?: () => number;
  readonly thinkingFlushIntervalMs?: number;
  readonly goalSyncIntervalMs?: number;
  readonly transientRefreshIntervalMs?: number;
  readonly postResponseTransientGraceMs?: number;
  readonly progressPacer?: ProgressPacer;
}

interface Menu {
  readonly text: string;
  readonly keyboard: TelegramInlineKeyboardMarkup;
}

export interface TelegramInboundMedia {
  readonly fileId: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly declaredBytes?: number;
  readonly kind: "image" | "file";
}

export interface TelegramInboundVoice {
  readonly fileId: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly declaredBytes?: number;
}

export interface StoredCodexAttachment {
  readonly path: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly kind: "image" | "file";
}

interface PendingMediaGroup {
  readonly attachment: CodexAttachmentRow;
  readonly target: CodexPaneIdentity;
  readonly chatId: number;
  readonly ownerUserId: number;
  readonly replyToMessageId: number;
  readonly items: TelegramInboundMedia[];
  caption: string;
  overflow: boolean;
  timer: NodeJS.Timeout;
}

interface ScreenReplacement {
  readonly messageId: number;
  readonly isPhoto: boolean;
}

interface DeferredTransientStart {
  readonly attachment: CodexAttachmentRow;
  readonly target: CodexPaneIdentity;
  readonly snapshot: CodexStatusSnapshot;
  readonly dueAt: number;
}

type TransientStatusKind =
  | "state_compacting"
  | "state_working"
  | "state_waiting_terminal"
  | "state_queued"
  | "state_activity"
  | "state_image_viewed"
  | "state_goal"
  | "state_interrupting"
  | "state_interrupted";

export class CodexTelegramController {
  private readonly bridge: CodexBridgeClient;
  private readonly mediaGroups = new Map<string, PendingMediaGroup>();
  private readonly textBurstTimers = new Map<string, NodeJS.Timeout>();
  private readonly flushingTextBursts = new Set<string>();
  private readonly transientMutationVersions = new Map<string, number>();
  private readonly transientRenderedAt = new Map<string, number>();
  private readonly transientRenderedReplyTo = new Map<string, number | null>();
  private readonly transientTimerRenderedAt = new Map<string, number>();
  private readonly deferredTransientStarts =
    new Map<string, DeferredTransientStart>();
  private readonly transientGraceUntil = new Map<string, number>();
  private readonly profile: () => ExperienceProfile;
  private readonly now: () => number;
  private readonly progressPacer: ProgressPacer;
  private readonly thinkingFlushIntervalMs: number;
  private readonly goalSyncIntervalMs: number;
  private readonly transientRefreshIntervalMs: number;
  private readonly postResponseTransientGraceMs: number;
  private lastGoalSyncAt = 0;

  constructor(private readonly dependencies: CodexTelegramDependencies) {
    this.bridge =
      dependencies.bridge ??
      new CodexBridgeClient(dependencies.env.CODEX_BRIDGE_SOCKET);
    this.profile = dependencies.profile ?? (() => DEFAULT_EXPERIENCE_PROFILE);
    this.now = dependencies.now ?? Date.now;
    this.progressPacer =
      dependencies.progressPacer ??
      new TelegramProgressPacer();
    this.thinkingFlushIntervalMs =
      dependencies.thinkingFlushIntervalMs ??
      THINKING_SECTION_FLUSH_INTERVAL_MS;
    this.goalSyncIntervalMs =
      dependencies.goalSyncIntervalMs ??
      GOAL_SYNC_INTERVAL_MS;
    this.transientRefreshIntervalMs =
      dependencies.transientRefreshIntervalMs ??
      TRANSIENT_REFRESH_INTERVAL_MS;
    this.postResponseTransientGraceMs =
      dependencies.postResponseTransientGraceMs ??
      POST_RESPONSE_TRANSIENT_GRACE_MS;
  }

  isAttached(
    chatId: number,
    ownerUserId: number,
    messageThreadId = 0,
  ): boolean {
    return this.dependencies.store.codexAttachment(
      chatId,
      ownerUserId,
      messageThreadId,
    ) !== null;
  }

  /** Attach the owner's chat to the persistent lobby when no session is active. */
  async ensureLobbyAttached(
    chatId: number,
    ownerUserId: number,
    messageThreadId = 0,
    force = false,
  ): Promise<boolean> {
    if (!force && this.isAttached(chatId, ownerUserId, messageThreadId)) {
      return true;
    }
    return (
      await this.attachLobby(chatId, ownerUserId, messageThreadId)
    ) !== null;
  }

  async handleCommand(
    message: TelegramMessage,
    command: { readonly name: string; readonly argument: string },
  ): Promise<boolean> {
    const chatId = message.chat.id;
    const ownerUserId = message.from?.id;
    if (!isTelegramIdentity(chatId, false) || !isTelegramIdentity(ownerUserId, true)) {
      return true;
    }
    const messageThreadId = telegramMessageThreadId(message);
    switch (command.name) {
      case "codex":
      case "codex_sessions":
        if (command.name === "codex" && command.argument) {
          const [subcommand, ...rest] = command.argument.split(/\s+/u);
          const subargument = rest.join(" ");
          if (subcommand?.toLowerCase() === "new") {
            await this.createAndAttach(
              chatId,
              ownerUserId!,
              normalizeName(subargument),
              message.message_id,
              messageThreadId,
            );
            return true;
          }
          if (subcommand?.toLowerCase() === "rename") {
            await this.rename(
              chatId,
              ownerUserId!,
              subargument,
              message.message_id,
              messageThreadId,
            );
            return true;
          }
          if (subcommand?.toLowerCase() === "detach") {
            await this.detach(
              chatId,
              ownerUserId!,
              message.message_id,
              messageThreadId,
            );
            return true;
          }
          if (subcommand?.toLowerCase() === "off") {
            await this.turnOff(
              chatId,
              ownerUserId!,
              message.message_id,
              messageThreadId,
            );
            return true;
          }
          if (subcommand?.toLowerCase() === "interrupt") {
            await this.interrupt(
              chatId,
              ownerUserId!,
              message.message_id,
              messageThreadId,
            );
            return true;
          }
          if (subcommand?.toLowerCase() === "screen") {
            await this.sendScreen(
              chatId,
              ownerUserId!,
              message.message_id,
              undefined,
              0,
              messageThreadId,
            );
            return true;
          }
          if (subcommand?.toLowerCase() === "key") {
            await this.sendKeyCommand(
              chatId,
              ownerUserId!,
              subargument,
              message.message_id,
              messageThreadId,
            );
            return true;
          }
          if (subcommand?.toLowerCase() === "help") {
            await tgSend(
              this.dependencies.env,
              chatId,
              codexHelpText(this.profile()),
              message.message_id,
              undefined,
              messageThreadId || undefined,
            );
            return true;
          }
        }
        await this.sendMenu(
          chatId,
          ownerUserId!,
          message.message_id,
          messageThreadId,
        );
        return true;
      case "attach":
      case "codex_attach":
        await this.attachByArgument(
          chatId,
          ownerUserId!,
          command.argument,
          message.message_id,
          messageThreadId,
        );
        return true;
      case "detach":
      case "unattach":
      case "codex_detach":
        await this.detach(
          chatId,
          ownerUserId!,
          message.message_id,
          messageThreadId,
        );
        return true;
      case "codex_new":
        await this.createAndAttach(
          chatId,
          ownerUserId!,
          normalizeName(command.argument),
          message.message_id,
          messageThreadId,
        );
        return true;
      case "codex_rename":
        await this.rename(
          chatId,
          ownerUserId!,
          command.argument,
          message.message_id,
          messageThreadId,
        );
        return true;
      case "codex_interrupt":
        await this.interrupt(
          chatId,
          ownerUserId!,
          message.message_id,
          messageThreadId,
        );
        return true;
      case "screen":
      case "codex_screen":
        await this.sendScreen(
          chatId,
          ownerUserId!,
          message.message_id,
          undefined,
          0,
          messageThreadId,
        );
        return true;
      case "key":
      case "codex_key":
        await this.sendKeyCommand(
          chatId,
          ownerUserId!,
          command.argument,
          message.message_id,
          messageThreadId,
        );
        return true;
      case "codex_help":
        await tgSend(
          this.dependencies.env,
          chatId,
          codexHelpText(this.profile()),
          message.message_id,
          undefined,
          messageThreadId || undefined,
        );
        return true;
      default:
        return false;
    }
  }

  async handleCallback(callback: TelegramCallbackQuery): Promise<boolean> {
    const chatId = callback.message?.chat.id;
    const messageId = callback.message?.message_id;
    const messageThreadId = telegramMessageThreadId(callback.message ?? {});
    const ownerUserId = callback.from.id;
    if (
      !isTelegramIdentity(chatId, false) ||
      !Number.isSafeInteger(messageId) ||
      Number(messageId) <= 0 ||
      !isTelegramIdentity(ownerUserId, true) ||
      typeof callback.data !== "string"
    ) {
      return false;
    }
    const parsed = await parseCallbackReference(
      this.dependencies.store.callbackStore(),
      callback.data,
      { chatId: chatId!, userId: ownerUserId },
    );
    if (!parsed.ok) {
      await tgAnswerCallbackQuery(this.dependencies.env, callback.id, {
        text: parsed.message,
        showAlert: true,
        cacheTime: 0,
      }).catch(() => undefined);
      return true;
    }
    if (!parsed.value.action.startsWith("codex.")) return false;

    await tgAnswerCallbackQuery(this.dependencies.env, callback.id, {
      text: callbackAnswer(parsed.value.action),
      cacheTime: 0,
    }).catch(() => undefined);

    switch (parsed.value.action) {
      case "codex.attach": {
        const target = parseTargetPayload(parsed.value.payload);
        if (!target) {
          await this.editError(chatId!, messageId!, "That session selection is invalid.");
          return true;
        }
        const panes = await this.listPanes();
        const pane = panes.find((candidate) => samePaneIdentity(candidate, target));
        if (!pane) {
          await this.editError(
            chatId!,
            messageId!,
            "That Codex session ended. Tap Refresh to discover sessions again.",
          );
          return true;
        }
        const source = this.dependencies.store.codexAttachment(
          chatId!,
          ownerUserId,
          messageThreadId,
        );
        if (chatId! < 0 && messageThreadId > 0 && source) {
          await this.routeForumHandoff(source, pane, "navigate", panes);
        } else {
          this.dependencies.store.attachCodex(
            chatId!,
            ownerUserId,
            pane,
            messageThreadId,
          );
        }
        await this.editMenu(chatId!, ownerUserId, messageId!, messageThreadId);
        return true;
      }
      case "codex.detach":
        await this.detach(chatId!, ownerUserId, messageId!, messageThreadId);
        await this.editMenu(chatId!, ownerUserId, messageId!, messageThreadId);
        return true;
      case "codex.refresh":
        await this.editMenu(chatId!, ownerUserId, messageId!, messageThreadId);
        return true;
      case "codex.new": {
        const result = await this.bridge.request({
          op: "new",
          name: nextFriendlyName(),
          cwd: this.dependencies.env.DEFAULT_CWD,
          ...workerDefaults(this.profile()),
        }).catch(() => null);
        if (!result?.ok || !("pane" in result)) {
          await this.editError(
            chatId!,
            messageId!,
            result && !result.ok
              ? result.error
              : "The session bridge is unavailable.",
          );
          return true;
        }
        const source = this.dependencies.store.codexAttachment(
          chatId!,
          ownerUserId,
          messageThreadId,
        );
        if (chatId! < 0 && messageThreadId > 0 && source) {
          await this.routeForumHandoff(
            source,
            result.pane,
            "created",
            await this.listPanes().catch(() => [result.pane]),
          );
        } else {
          this.dependencies.store.attachCodex(
            chatId!,
            ownerUserId,
            result.pane,
            messageThreadId,
          );
        }
        await this.editMenu(chatId!, ownerUserId, messageId!, messageThreadId);
        return true;
      }
      case "codex.resume": {
        const saved = parseResumePayload(parsed.value.payload);
        if (!saved) {
          await this.editError(chatId!, messageId!, "That saved session is invalid.");
          return true;
        }
        const result = await this.bridge.request({
          op: "resume",
          sessionId: saved.id,
          name: saved.name,
          ...workerDefaults(this.profile()),
        }).catch(() => null);
        if (!result?.ok || !("pane" in result)) {
          await this.editError(
            chatId!,
            messageId!,
            result && !result.ok
              ? result.error
              : "The session bridge is unavailable.",
          );
          return true;
        }
        const source = this.dependencies.store.codexAttachment(
          chatId!,
          ownerUserId,
          messageThreadId,
        );
        if (chatId! < 0 && messageThreadId > 0 && source) {
          await this.routeForumHandoff(
            source,
            result.pane,
            "created",
            await this.listPanes().catch(() => [result.pane]),
          );
        } else {
          this.dependencies.store.attachCodex(
            chatId!,
            ownerUserId,
            result.pane,
            messageThreadId,
          );
        }
        await this.editMenu(chatId!, ownerUserId, messageId!, messageThreadId);
        return true;
      }
      case "codex.interrupt": {
        const attachment = this.dependencies.store.codexAttachment(
          chatId!,
          ownerUserId,
          messageThreadId,
        );
        if (!attachment) {
          await this.editMenu(chatId!, ownerUserId, messageId!, messageThreadId);
          return true;
        }
        await this.bridge.request({
          op: "interrupt",
          target: attachmentTarget(attachment),
        }).catch(() => null);
        await this.editMenu(chatId!, ownerUserId, messageId!, messageThreadId);
        return true;
      }
      case "codex.transient_interrupt": {
        const attachment = this.dependencies.store.codexAttachment(
          chatId!,
          ownerUserId,
          messageThreadId,
        );
        if (!attachment) return true;
        const result = await this.bridge.request({
          op: "interrupt",
          target: attachmentTarget(attachment),
        }).catch(() => null);
        if (!result?.ok || !("interrupted" in result)) {
          await this.editError(
            chatId!,
            messageId!,
            result && !result.ok
              ? `⚠️ ${escapeTelegramHtml(result.error)}`
              : "⚠️ The interrupt could not be sent.",
          );
          return true;
        }
        await this.setTransientStatus(
          attachment,
          attachmentTarget(attachment),
          "state_interrupting",
        );
        return true;
      }
      case "codex.goal_pause":
        await this.setGoalStatus(
          chatId!,
          ownerUserId,
          messageThreadId,
          "paused",
          messageId!,
        );
        return true;
      case "codex.goal_resume":
        await this.setGoalStatus(
          chatId!,
          ownerUserId,
          messageThreadId,
          "active",
          messageId!,
        );
        return true;
      case "codex.goal_edit": {
        const goal = this.dependencies.store.codexGoal(
          chatId!,
          ownerUserId,
          messageThreadId,
        );
        if (!goal) return true;
        this.dependencies.store.setCodexGoalAwaitingEdit(
          chatId!,
          ownerUserId,
          messageThreadId,
          true,
        );
        const shown = await this.showGoalEditPrompt(
          chatId!,
          ownerUserId,
          messageThreadId,
          messageId!,
          goal,
        );
        if (!shown) {
          this.dependencies.store.setCodexGoalAwaitingEdit(
            chatId!,
            ownerUserId,
            messageThreadId,
            false,
          );
          await tgSend(
            this.dependencies.env,
            chatId!,
            "⚠️ I couldn’t open the goal editor. The current goal was kept.",
            messageId!,
            undefined,
            messageThreadId || undefined,
          );
        }
        return true;
      }
      case "codex.goal_edit_cancel": {
        const attachment = this.dependencies.store.codexAttachment(
          chatId!,
          ownerUserId,
          messageThreadId,
        );
        const goal = this.dependencies.store.codexGoal(
          chatId!,
          ownerUserId,
          messageThreadId,
        );
        this.dependencies.store.setCodexGoalAwaitingEdit(
          chatId!,
          ownerUserId,
          messageThreadId,
          false,
        );
        if (attachment && goal) {
          await this.refreshGoalTransient(
            attachment,
            threadGoalFromRow(goal),
            true,
          );
        }
        return true;
      }
      case "codex.goal_clear":
        await this.sendGoalClearConfirmation(
          chatId!,
          ownerUserId,
          messageThreadId,
          messageId!,
        );
        return true;
      case "codex.goal_clear_confirm":
        await this.clearGoal(
          chatId!,
          ownerUserId,
          messageThreadId,
          messageId!,
        );
        return true;
      case "codex.screen":
        await this.sendScreen(
          chatId!,
          ownerUserId,
          undefined,
          {
            messageId: messageId!,
            isPhoto: Boolean(callback.message?.photo?.length),
          },
          0,
          messageThreadId,
        );
        return true;
      case "codex.key": {
        const key = parseKeyPayload(parsed.value.payload);
        if (!key) return true;
        await this.sendKeys(
          chatId!,
          ownerUserId,
          [key],
          messageId!,
          messageThreadId,
        );
        await this.sendScreen(
          chatId!,
          ownerUserId,
          undefined,
          {
            messageId: messageId!,
            isPhoto: Boolean(callback.message?.photo?.length),
          },
          250,
          messageThreadId,
        );
        return true;
      }
      default:
        return false;
    }
  }

  async routeAttachedMessage(message: TelegramMessage): Promise<boolean> {
    const chatId = message.chat.id;
    const ownerUserId = message.from?.id;
    if (
      !message.text ||
      !isTelegramIdentity(chatId, false) ||
      !isTelegramIdentity(ownerUserId, true)
    ) {
      return false;
    }
    const attachment = this.dependencies.store.codexAttachment(
      chatId,
      ownerUserId!,
      telegramMessageThreadId(message),
    );
    if (!attachment) return false;
    const target = attachmentTarget(attachment);
    this.clearPostResponseTransientGrace(attachment, target);
    const goal = this.dependencies.store.codexGoal(
      chatId,
      ownerUserId!,
      telegramMessageThreadId(message),
    );
    if (goal?.awaiting_edit === 1) {
      this.dependencies.store.setCodexGoalAwaitingEdit(
        chatId,
        ownerUserId!,
        telegramMessageThreadId(message),
        false,
      );
      if (message.text.trim().toLowerCase() === "/cancel") {
        await this.refreshGoalTransient(
          attachment,
          threadGoalFromRow(goal),
          true,
        );
        await tgSend(
          this.dependencies.env,
          chatId,
          "Kept the current goal.",
          message.message_id,
          undefined,
          telegramMessageThreadId(message) || undefined,
        );
        return true;
      }
      const response = await this.bridge.request({
        op: "goal_set",
        target,
        objective: message.text.trim(),
      }).catch(() => null);
      if (!response?.ok || !("goal" in response) || !response.goal) {
        await this.refreshGoalTransient(
          attachment,
          threadGoalFromRow(goal),
          true,
        );
        await tgSend(
          this.dependencies.env,
          chatId,
          response && !response.ok
            ? `⚠️ ${escapeTelegramHtml(response.error)}`
            : "⚠️ Goal editing is temporarily unavailable.",
          message.message_id,
          undefined,
          telegramMessageThreadId(message) || undefined,
        );
        return true;
      }
      this.dependencies.store.observeCodexGoal(
        chatId,
        ownerUserId!,
        telegramMessageThreadId(message),
        response.goal,
      );
      await this.refreshGoalTransient(attachment, response.goal, true);
      return true;
    }
    const hadActivityStatus = this.dependencies.store.codexStatus(
      attachment.chat_id,
      attachment.owner_user_id,
      target,
    ) !== null;
    const burstKey = codexOwnerTargetKey(
      attachment.chat_id,
      attachment.owner_user_id,
      target,
    );
    const arrowKeys = parseArrowShortcut(message.text);
    if (arrowKeys) {
      await this.flushTextBurst(burstKey);
      await this.sendKeyCommand(
        attachment.chat_id,
        attachment.owner_user_id,
        arrowKeys.join(" "),
        message.message_id,
      );
      return true;
    }

    if (message.text.trimStart().startsWith("/")) {
      await this.flushTextBurst(burstKey);
      const queued = /^\/queue(?:@\w+)?(?:\s+([\s\S]+))?$/iu.exec(
        message.text.trim(),
      );
      if (queued) {
        const text = queued[1]?.trim() ?? "";
        if (!text) {
          await tgSend(
            this.dependencies.env,
            chatId,
            "Use <code>/queue your follow-up</code> to hold it for the next turn.",
            message.message_id,
            undefined,
            telegramMessageThreadId(message) || undefined,
          );
          return true;
        }
        await this.relayPrompt(
          attachment,
          target,
          text,
          message.message_id,
          true,
          1,
          "queue",
        );
        return true;
      }
      await this.relayPrompt(
        attachment,
        target,
        message.text,
        message.message_id,
      );
      return true;
    }

    await this.setTransientStatus(
      attachment,
      target,
      "state_working",
      message.message_id,
      undefined,
      undefined,
      true,
    );
    const queuedCount = this.dependencies.store.queueCodexPrompt(
      attachment.chat_id,
      attachment.owner_user_id,
      target,
      message.message_id,
      buildTelegramTextPrompt(message),
    );
    if (queuedCount > 1 && !hadActivityStatus) {
      await this.setTransientStatus(
        attachment,
        target,
        "state_queued",
        message.message_id,
        queuedCount,
      );
    }
    this.scheduleTextBurst(burstKey);
    return true;
  }

  async routeAttachedMedia(message: TelegramMessage): Promise<boolean> {
    const media = selectTelegramMedia(message);
    const chatId = message.chat.id;
    const ownerUserId = message.from?.id;
    if (
      !media ||
      !isTelegramIdentity(chatId, false) ||
      !isTelegramIdentity(ownerUserId, true)
    ) {
      return false;
    }
    const attachment = this.dependencies.store.codexAttachment(
      chatId,
      ownerUserId!,
      telegramMessageThreadId(message),
    );
    if (!attachment) return false;
    const target = attachmentTarget(attachment);
    this.clearPostResponseTransientGrace(attachment, target);

    await this.setTransientStatus(
      attachment,
      target,
      "state_working",
      message.message_id,
      undefined,
      undefined,
      true,
    );

    const mediaGroupId = message.media_group_id?.trim();
    if (mediaGroupId) {
      this.queueMediaGroup(
        attachment,
        target,
        message,
        media,
        mediaGroupId,
      );
      return true;
    }

    await this.relayMedia(
      attachment,
      target,
      [media],
      message.caption ?? "",
      message.message_id,
    );
    return true;
  }

  async routeAttachedVoice(message: TelegramMessage): Promise<boolean> {
    const voice = selectTelegramVoice(message);
    const chatId = message.chat.id;
    const ownerUserId = message.from?.id;
    if (
      !voice ||
      !isTelegramIdentity(chatId, false) ||
      !isTelegramIdentity(ownerUserId, true)
    ) {
      return false;
    }
    const attachment = this.dependencies.store.codexAttachment(
      chatId,
      ownerUserId!,
      telegramMessageThreadId(message),
    );
    if (!attachment) return false;
    const target = attachmentTarget(attachment);
    this.clearPostResponseTransientGrace(attachment, target);

    await this.setTransientStatus(
      attachment,
      target,
      "state_working",
      message.message_id,
      undefined,
      undefined,
      true,
    );

    try {
      if (
        voice.declaredBytes !== undefined &&
        voice.declaredBytes > CODEX_ATTACHMENT_MAX_BYTES
      ) {
        throw new Error("That voice note is too large. The limit is 20 MB.");
      }
      const apiKey = this.dependencies.env.ELEVENLABS_API_KEY;
      if (!apiKey) {
        throw new Error("Voice transcription is not configured yet.");
      }
      const telegramFile = await tgGetFile(
        this.dependencies.env,
        voice.fileId,
      );
      if (!telegramFile.file_path) {
        throw new Error("Telegram did not return a voice-note path.");
      }
      const audio = await tgDownloadFile(
        this.dependencies.env,
        telegramFile.file_path,
        CODEX_ATTACHMENT_MAX_BYTES,
      );
      const transcript = await transcribeScribeV2({
        apiKey,
        audio,
        fileName: voice.fileName,
        mimeType: voice.mimeType,
        languageCode: this.dependencies.env.SCRIBE_LANGUAGE_CODE,
        keyterms: this.dependencies.env.SCRIBE_KEYTERMS,
      });
      await this.sendVoiceTranscriptReceipt(
        attachment,
        transcript,
        message.message_id,
      );
      const promptText = message.caption?.trim()
        ? `${transcript}\n\n${message.caption.trim()}`
        : transcript;
      await this.relayPrompt(
        attachment,
        target,
        buildTelegramTextPrompt({ ...message, text: promptText }),
        message.message_id,
      );
    } catch (error) {
      await this.failMediaRelay(
        attachment,
        target,
        message.message_id,
        error instanceof Error
          ? error.message
          : "That voice note could not be transcribed.",
      );
    }
    return true;
  }

  private async sendVoiceTranscriptReceipt(
    attachment: CodexAttachmentRow,
    transcript: string,
    replyToMessageId: number,
  ): Promise<void> {
    const chunks = voiceTranscriptReceiptHtml(transcript);
    for (const [index, html] of chunks.entries()) {
      const sent = await tgSendRichHtml(
        this.dependencies.env,
        attachment.chat_id,
        html,
        index === 0 ? replyToMessageId : undefined,
        undefined,
        attachment.message_thread_id || undefined,
      ).catch(() => null);
      if (!sent?.ok) return;
    }
  }

  private async relayPrompt(
    attachment: CodexAttachmentRow,
    target: CodexPaneIdentity,
    text: string,
    replyToMessageId: number,
    reportFailure = true,
    sourceMessageCount = 1,
    mode: "steer" | "queue" = "steer",
  ): Promise<boolean> {
    await this.setTransientStatus(
      attachment,
      target,
      "state_working",
      replyToMessageId,
      undefined,
      undefined,
      true,
    );
    const response = await this.bridge.request({
      op: "send",
      target,
      text,
      mode,
      deliveryId: telegramDeliveryId(attachment, replyToMessageId),
    }).catch(() => null);
    if (!response?.ok) {
      const transient = this.takeTransientStatus(attachment, target);
      if (transient) {
        await tgDeleteMessage(
          this.dependencies.env,
          attachment.chat_id,
          transient.telegram_message_id,
        ).catch(() => undefined);
      }
      const forumSource =
        attachment.chat_id < 0 && attachment.message_thread_id > 0;
      if (response?.code === "STALE_TARGET" && !forumSource) {
        await this.attachLobby(
          attachment.chat_id,
          attachment.owner_user_id,
          attachment.message_thread_id,
        );
      }
      if (reportFailure) {
        const manager = response?.code === "STALE_TARGET" && forumSource
          ? this.dependencies.store.managerTopic(attachment.chat_id)
          : null;
        const managerAttachment = manager
          ? this.dependencies.store.codexAttachment(
              attachment.chat_id,
              attachment.owner_user_id,
              manager.message_thread_id,
            )
          : null;
        const managerUrl = managerAttachment
          ? forumTopicUrl(
              managerAttachment.chat_id,
              managerAttachment.message_thread_id,
            )
          : null;
        await tgSend(
          this.dependencies.env,
          attachment.chat_id,
          response && !response.ok
            ? `⚠️ ${escapeTelegramHtml(response.error)}\n` +
              (forumSource
                ? managerAttachment
                  ? `Open ${escapeTelegramHtml(this.profile().manager.name)} ` +
                    "to reconnect or resume this worker."
                  : `Send <code>/manager wake</code> in the ` +
                    `${escapeTelegramHtml(this.profile().manager.name)} topic.`
                : "🪄 You’re back in Lobby; resend your message there.")
            : "⚠️ The session bridge is unavailable. Your message was not sent.",
          replyToMessageId,
          managerUrl
            ? {
                inline_keyboard: [[{
                  text: `Open ${this.profile().manager.name}`.slice(0, 64),
                  url: managerUrl,
                }]],
              }
            : undefined,
          attachment.message_thread_id || undefined,
        );
      }
      await this.dependencies.topicPresence?.markReady(attachment)
        .catch(() => undefined);
      return false;
    }
    this.dependencies.store.recordCodexPrompt(
      attachment.chat_id,
      attachment.owner_user_id,
      target,
      replyToMessageId,
      "queuedUntilNextToolCall" in response &&
        response.queuedUntilNextToolCall,
      attachment.message_thread_id,
    );
    if (
      "queuedUntilNextToolCall" in response &&
      response.queuedUntilNextToolCall
    ) {
      await this.setQueuedFollowupStatus(
        attachment,
        target,
        replyToMessageId,
        sourceMessageCount,
      );
    } else if (mode === "queue") {
      await tgSend(
        this.dependencies.env,
        attachment.chat_id,
        "No turn was active, so I started that message now.",
        replyToMessageId,
        undefined,
        attachment.message_thread_id || undefined,
      ).catch(() => undefined);
    }
    return true;
  }

  private scheduleTextBurst(key: string, delayMs = TELEGRAM_TEXT_BURST_DEBOUNCE_MS): void {
    const existing = this.textBurstTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.textBurstTimers.delete(key);
      void this.flushTextBurst(key).catch(() => {
        console.error("[ChatinaboxTelegram] Text burst relay failed.");
      });
    }, delayMs);
    timer.unref();
    this.textBurstTimers.set(key, timer);
  }

  private async flushReadyTextBursts(): Promise<void> {
    for (const group of this.dependencies.store.queuedCodexPromptGroups()) {
      const target: CodexPaneIdentity = {
        serverPid: group.server_pid,
        paneId: group.pane_id,
        panePid: group.pane_pid,
      };
      const key = codexOwnerTargetKey(
        group.chat_id,
        group.owner_user_id,
        target,
      );
      const queued = this.dependencies.store.queuedCodexPrompts(
        group.chat_id,
        group.owner_user_id,
        target,
      );
      const newest = queued[queued.length - 1];
      if (
        newest &&
        Date.now() - newest.created_at >= TELEGRAM_TEXT_BURST_DEBOUNCE_MS
      ) {
        await this.flushTextBurst(key);
      }
    }
  }

  private async flushTextBurst(key: string): Promise<void> {
    if (this.flushingTextBursts.has(key)) return;
    const parsed = parseCodexOwnerTargetKey(key);
    if (!parsed) return;
    this.flushingTextBursts.add(key);
    try {
      const queued = this.dependencies.store.queuedCodexPrompts(
        parsed.chatId,
        parsed.ownerUserId,
        parsed.target,
      );
      if (queued.length === 0) return;
      const attachment = this.dependencies.store.codexAttachmentForTarget(
        parsed.chatId,
        parsed.ownerUserId,
        parsed.target,
      );
      if (
        !attachment ||
        !samePaneIdentity(attachmentTarget(attachment), parsed.target)
      ) {
        this.dependencies.store.deleteQueuedCodexPrompts(
          queued.map((row) => row.id),
        );
        return;
      }
      const sent = await this.relayPrompt(
        attachment,
        parsed.target,
        buildBundledTelegramPrompt(queued.map((row) => row.text)),
        queued[queued.length - 1].telegram_message_id,
        false,
        queued.length,
      );
      if (sent) {
        this.dependencies.store.deleteQueuedCodexPrompts(
          queued.map((row) => row.id),
        );
      } else {
        this.scheduleTextBurst(key, 2_000);
      }
    } finally {
      this.flushingTextBursts.delete(key);
    }
  }

  private queueMediaGroup(
    attachment: CodexAttachmentRow,
    target: CodexPaneIdentity,
    message: TelegramMessage,
    media: TelegramInboundMedia,
    mediaGroupId: string,
  ): void {
    const key =
      `${attachment.chat_id}:${attachment.owner_user_id}:${mediaGroupId}`;
    const existing = this.mediaGroups.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      if (existing.items.length < CODEX_ATTACHMENT_MAX_COUNT) {
        existing.items.push(media);
      } else {
        existing.overflow = true;
      }
      if (!existing.caption && message.caption?.trim()) {
        existing.caption = message.caption.trim();
      }
      existing.timer = this.scheduleMediaGroup(key);
      return;
    }
    this.mediaGroups.set(key, {
      attachment,
      target,
      chatId: attachment.chat_id,
      ownerUserId: attachment.owner_user_id,
      replyToMessageId: message.message_id,
      items: [media],
      caption: message.caption?.trim() ?? "",
      overflow: false,
      timer: this.scheduleMediaGroup(key),
    });
  }

  private scheduleMediaGroup(key: string): NodeJS.Timeout {
    const timer = setTimeout(() => {
      void this.flushMediaGroup(key).catch(() => {
        console.error("[ChatinaboxTelegram] Media album relay failed.");
      });
    }, TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS);
    timer.unref();
    return timer;
  }

  private async flushMediaGroup(key: string): Promise<void> {
    const pending = this.mediaGroups.get(key);
    if (!pending) return;
    this.mediaGroups.delete(key);
    if (pending.overflow) {
      await this.failMediaRelay(
        pending.attachment,
        pending.target,
        pending.replyToMessageId,
        `Send at most ${CODEX_ATTACHMENT_MAX_COUNT} attachments in one album.`,
      );
      return;
    }
    await this.relayMedia(
      pending.attachment,
      pending.target,
      pending.items,
      pending.caption,
      pending.replyToMessageId,
    );
  }

  private async relayMedia(
    attachment: CodexAttachmentRow,
    target: CodexPaneIdentity,
    media: readonly TelegramInboundMedia[],
    caption: string,
    replyToMessageId: number,
  ): Promise<void> {
    const declaredTotal = media.reduce(
      (total, item) => total + (item.declaredBytes ?? 0),
      0,
    );
    if (
      media.length === 0 ||
      media.length > CODEX_ATTACHMENT_MAX_COUNT ||
      media.some(
        (item) =>
          item.declaredBytes !== undefined &&
          item.declaredBytes > CODEX_ATTACHMENT_MAX_BYTES,
      ) ||
      declaredTotal > CODEX_ATTACHMENT_MAX_TOTAL_BYTES
    ) {
      await this.failMediaRelay(
        attachment,
        target,
        replyToMessageId,
        "Those attachments are too large. The limit is 20 MB each and 50 MB per message.",
      );
      return;
    }

    const root = path.join(
      this.dependencies.env.DATA_DIR,
      "codex-attachments",
    );
    const turnDir = path.join(root, randomUUID());
    try {
      mkdirSync(turnDir, { recursive: true, mode: 0o700 });
      chmodSync(turnDir, 0o700);
      const stored: StoredCodexAttachment[] = [];
      let totalBytes = 0;
      for (let index = 0; index < media.length; index += 1) {
        const item = media[index];
        const telegramFile = await tgGetFile(
          this.dependencies.env,
          item.fileId,
        );
        if (!telegramFile.file_path) {
          throw new Error("Telegram did not return an attachment path.");
        }
        const remaining = CODEX_ATTACHMENT_MAX_TOTAL_BYTES - totalBytes;
        const bytes = await tgDownloadFile(
          this.dependencies.env,
          telegramFile.file_path,
          Math.min(CODEX_ATTACHMENT_MAX_BYTES, remaining),
        );
        totalBytes += bytes.byteLength;
        const fileName =
          `${String(index + 1).padStart(2, "0")}-` +
          sanitizeAttachmentFileName(item.fileName);
        const filePath = path.join(turnDir, fileName);
        writeFileSync(filePath, bytes, { mode: 0o600, flag: "wx" });
        chmodSync(filePath, 0o600);
        stored.push({
          path: filePath,
          fileName,
          mimeType: item.mimeType,
          bytes: bytes.byteLength,
          kind: item.kind,
        });
      }
      pruneOldAttachmentDirectories(root, Date.now());
      await this.relayPrompt(
        attachment,
        target,
        buildCodexAttachmentPrompt(stored, caption),
        replyToMessageId,
      );
    } catch (error) {
      rmSync(turnDir, { recursive: true, force: true });
      await this.failMediaRelay(
        attachment,
        target,
        replyToMessageId,
        error instanceof Error
          ? error.message
          : "The attachments could not be prepared.",
      );
    }
  }

  private async failMediaRelay(
    attachment: CodexAttachmentRow,
    target: CodexPaneIdentity,
    replyToMessageId: number,
    message: string,
  ): Promise<void> {
    const transient = this.takeTransientStatus(attachment, target);
    if (transient) {
      await tgDeleteMessage(
        this.dependencies.env,
        attachment.chat_id,
        transient.telegram_message_id,
      ).catch(() => undefined);
    }
    await tgSend(
      this.dependencies.env,
      attachment.chat_id,
      `⚠️ ${escapeTelegramHtml(message)}`,
      replyToMessageId,
    ).catch(() => undefined);
    await this.dependencies.topicPresence?.markReady(attachment)
      .catch(() => undefined);
  }

  async run(signal: AbortSignal): Promise<void> {
    let lobbyReady = false;
    for (let attempt = 0; attempt < 5 && !signal.aborted; attempt += 1) {
      const response = await this.bridge.request({ op: "lobby" })
        .catch(() => null);
      if (response?.ok) {
        lobbyReady = true;
        break;
      }
      await abortableSleep(500, signal).catch(() => undefined);
    }
    if (!lobbyReady && !signal.aborted) {
      console.error("[ChatinaboxTelegram] Lobby could not be started.");
    }
    while (!signal.aborted) {
      try {
        await this.deliverEventsOnce();
        await this.flushReadyTextBursts();
        if (this.now() - this.lastGoalSyncAt >= this.goalSyncIntervalMs) {
          await this.syncGoalsOnce();
        }
        await this.flushDeferredTransientStartsOnce();
        await this.refreshStaleTransientTimersOnce();
      } catch {
        if (!signal.aborted) {
          console.error("[ChatinaboxTelegram] Event delivery pass failed; retrying.");
        }
      }
      await abortableSleep(1_000, signal).catch(() => undefined);
    }
  }

  async syncGoalsOnce(): Promise<void> {
    this.lastGoalSyncAt = this.now();
    const response = await this.bridge.request({ op: "goals" }).catch(() => null);
    if (!response?.ok || !("goals" in response)) return;
    for (const observation of response.goals) {
      if (observation.error) continue;
      const attachments =
        this.dependencies.store.codexAttachmentsForTarget(observation.target);
      for (const attachment of attachments) {
        const previous = this.dependencies.store.codexGoal(
          attachment.chat_id,
          attachment.owner_user_id,
          attachment.message_thread_id,
        );
        const current = this.dependencies.store.observeCodexGoal(
          attachment.chat_id,
          attachment.owner_user_id,
          attachment.message_thread_id,
          observation.goal,
        );
        if (!observation.goal) {
          if (previous) {
            await this.removeGoalOnlyTransient(attachment);
          }
          continue;
        }
        if (observation.goal.status === "complete") {
          await this.removeGoalOnlyTransient(attachment);
          continue;
        }
        const transient = this.dependencies.store.codexStatus(
          attachment.chat_id,
          attachment.owner_user_id,
          attachmentTarget(attachment),
        );
        if (
          !transient ||
          !previous ||
          previous.goal_updated_at !== current?.goal_updated_at ||
          previous.status !== current?.status ||
          previous.objective !== current?.objective
        ) {
          await this.refreshGoalTransient(attachment, observation.goal);
        }
      }
    }
    await this.deliverPendingGoalCompletions();
  }

  private async setGoalStatus(
    chatId: number,
    ownerUserId: number,
    messageThreadId: number,
    status: "active" | "paused",
    replyToMessageId: number,
  ): Promise<void> {
    const attachment = this.dependencies.store.codexAttachment(
      chatId,
      ownerUserId,
      messageThreadId,
    );
    if (!attachment) return;
    const response = await this.bridge.request({
      op: "goal_set",
      target: attachmentTarget(attachment),
      status,
    }).catch(() => null);
    if (!response?.ok || !("goal" in response) || !response.goal) {
      await tgSend(
        this.dependencies.env,
        chatId,
        response && !response.ok
          ? `⚠️ ${escapeTelegramHtml(response.error)}`
          : "⚠️ Goal controls are temporarily unavailable.",
        replyToMessageId,
        undefined,
        messageThreadId || undefined,
      );
      return;
    }
    this.dependencies.store.observeCodexGoal(
      chatId,
      ownerUserId,
      messageThreadId,
      response.goal,
    );
    await this.refreshGoalTransient(attachment, response.goal, true);
    if (status === "active") {
      // A sidecar can mutate persisted goal state, but the terminal-owned TUI
      // remains the continuation engine. Wake its native goal command so a
      // resumed goal starts cooking instead of merely looking active in Nexus.
      await this.bridge.request({
        op: "send",
        target: attachmentTarget(attachment),
        text: "/goal",
        mode: "queue",
        deliveryId: [
          "goal-resume",
          chatId,
          ownerUserId,
          messageThreadId,
          replyToMessageId,
        ].join(":"),
      }).catch(() => null);
    }
  }

  private async sendGoalClearConfirmation(
    chatId: number,
    ownerUserId: number,
    messageThreadId: number,
    replyToMessageId: number,
  ): Promise<void> {
    if (!this.dependencies.store.codexGoal(
      chatId,
      ownerUserId,
      messageThreadId,
    )) return;
    const confirm = await issueCallbackReference(
      this.dependencies.store.callbackStore(),
      {
        action: "codex.goal_clear_confirm",
        chatId,
        userId: ownerUserId,
        payload: {},
        ttlMs: 5 * 60 * 1_000,
      },
    );
    await tgSend(
      this.dependencies.env,
      chatId,
      "Clear this goal? This removes the native goal state; completed-goal " +
        "history is unaffected.",
      replyToMessageId,
      buildInlineKeyboard([
        [{ label: "Clear goal", callbackData: confirm.callbackData }],
      ]),
      messageThreadId || undefined,
    );
  }

  private async showGoalEditPrompt(
    chatId: number,
    ownerUserId: number,
    messageThreadId: number,
    messageId: number,
    goal: CodexGoalRow,
  ): Promise<boolean> {
    const keyboard = await this.goalEditKeyboard(
      chatId,
      ownerUserId,
    );
    const edited = await tgEditRichHtml(
      this.dependencies.env,
      chatId,
      messageId,
      formatGoalEditPrompt(goal),
      keyboard,
    ).catch(() => null);
    return telegramEditSucceeded(edited);
  }

  private async goalEditKeyboard(
    chatId: number,
    ownerUserId: number,
  ): Promise<TelegramInlineKeyboardMarkup> {
    const cancel = await issueCallbackReference(
      this.dependencies.store.callbackStore(),
      {
        action: "codex.goal_edit_cancel",
        chatId,
        userId: ownerUserId,
        payload: {},
        ttlMs: 15 * 60 * 1_000,
      },
    );
    return buildInlineKeyboard([
      [{ label: "Cancel edit", callbackData: cancel.callbackData }],
    ]);
  }

  private async clearGoal(
    chatId: number,
    ownerUserId: number,
    messageThreadId: number,
    replyToMessageId: number,
  ): Promise<void> {
    const attachment = this.dependencies.store.codexAttachment(
      chatId,
      ownerUserId,
      messageThreadId,
    );
    if (!attachment) return;
    const response = await this.bridge.request({
      op: "goal_clear",
      target: attachmentTarget(attachment),
    }).catch(() => null);
    if (!response?.ok || !("goalCleared" in response)) {
      await tgSend(
        this.dependencies.env,
        chatId,
        response && !response.ok
          ? `⚠️ ${escapeTelegramHtml(response.error)}`
          : "⚠️ Goal clearing is temporarily unavailable.",
        replyToMessageId,
        undefined,
        messageThreadId || undefined,
      );
      return;
    }
    this.dependencies.store.observeCodexGoal(
      chatId,
      ownerUserId,
      messageThreadId,
      null,
    );
    await this.removeGoalOnlyTransient(attachment);
    await tgSend(
      this.dependencies.env,
      chatId,
      "Goal cleared.",
      replyToMessageId,
      undefined,
      messageThreadId || undefined,
    );
  }

  private async refreshGoalTransient(
    attachment: CodexAttachmentRow,
    goal: CodexThreadGoal,
    forceRender = false,
  ): Promise<void> {
    if (goal.status === "complete") return;
    const target = attachmentTarget(attachment);
    const existing = this.dependencies.store.codexStatus(
      attachment.chat_id,
      attachment.owner_user_id,
      target,
    );
    await this.setTransientStatus(
      attachment,
      target,
      existing ? existing.status_kind as TransientStatusKind : "state_goal",
      undefined,
      undefined,
      undefined,
      true,
      undefined,
      forceRender,
    );
  }

  private async removeGoalOnlyTransient(
    attachment: CodexAttachmentRow,
  ): Promise<void> {
    const target = attachmentTarget(attachment);
    const existing = this.dependencies.store.codexStatus(
      attachment.chat_id,
      attachment.owner_user_id,
      target,
    );
    if (existing?.status_kind !== "state_goal") return;
    const removed = this.takeTransientStatus(attachment, target);
    if (removed) {
      await tgDeleteMessage(
        this.dependencies.env,
        attachment.chat_id,
        removed.telegram_message_id,
      ).catch(() => undefined);
    }
  }

  private async deliverPendingGoalCompletions(): Promise<void> {
    for (const completion of this.dependencies.store.pendingCodexGoalCompletions()) {
      const sent = await tgSendRichHtml(
        this.dependencies.env,
        completion.chat_id,
        formatGoalCompletion(completion),
        undefined,
        undefined,
        completion.message_thread_id || undefined,
      ).catch(() => null);
      if (!sent?.ok) continue;
      this.dependencies.store.markCodexGoalCompletionAnnounced(
        completion.id,
        sent.result.message_id,
      );
    }
  }

  async deliverEventsOnce(): Promise<void> {
    const response = await this.bridge
      .request({ op: "events", limit: 10 })
      .catch(() => null);
    if (!response?.ok || !("events" in response)) {
      await this.flushDueThinkingSections();
      return;
    }
    for (let index = 0; index < response.events.length;) {
      const grouped = [response.events[index]];
      let event = response.events[index];
      while (
        event.kind === "state_activity" &&
        index + grouped.length < response.events.length
      ) {
        const next = response.events[index + grouped.length];
        if (
          next.kind !== "state_activity" ||
          !samePaneIdentity(next.target, event.target)
        ) break;
        grouped.push(next);
        event = next;
      }
      const delivered = await this.deliverEvent(event);
      if (!delivered) return;
      for (const deliveredEvent of grouped) {
        await this.bridge.request({
          op: "ack",
          eventId: deliveredEvent.id,
        });
      }
      index += grouped.length;
    }
    await this.flushDueThinkingSections();
  }

  private async deliverEvent(event: CodexEvent): Promise<boolean> {
    const attachments =
      this.dependencies.store.codexAttachmentsForTarget(event.target);
    if (event.kind === "image_generated") {
      return this.deliverGeneratedImage(event, attachments);
    }
    if (attachments.length === 0) return true;
    if (event.kind === "session_renamed") {
      const panes = await this.listPanes().catch(() => []);
      const pane = panes.find((candidate) =>
        samePaneIdentity(candidate, event.target)
      );
      if (!pane) return true;
      this.dependencies.store.renameAttachedCodexTarget(event.target, pane);
      for (const attachment of attachments) {
        const sent = await tgSend(
          this.dependencies.env,
          attachment.chat_id,
          `🪄 <b>Session renamed</b> · ${escapeTelegramHtml(pane.windowName)}`,
          undefined,
          undefined,
          attachment.message_thread_id || undefined,
        );
        if (!sent.ok) return false;
      }
      return true;
    }
    if (event.kind === "session_handoff") {
      const handoff = parseHandoffDirective(event.message);
      const panes = handoff
        ? await this.listPanes().catch(() => [])
        : [];
      const pane = handoff
        ? panes.find((candidate) =>
          samePaneIdentity(candidate, handoff.destination)
        )
        : undefined;
      for (const attachment of attachments) {
        if (!pane) {
          const failed = await tgSend(
            this.dependencies.env,
            attachment.chat_id,
              "⚠️ <b>Handoff could not complete.</b>\n" +
              "The destination session is no longer running; you remain here.",
            undefined,
            undefined,
            attachment.message_thread_id || undefined,
          );
          if (!failed.ok) return false;
          continue;
        }
        if (attachment.chat_id < 0) {
          await this.routeForumHandoff(
            attachment,
            pane,
            handoff?.kind ?? "navigate",
            panes,
          );
          continue;
        }
        this.dependencies.store.attachCodex(
          attachment.chat_id,
          attachment.owner_user_id,
          pane,
          attachment.message_thread_id,
        );
        const sent = await tgSend(
          this.dependencies.env,
          attachment.chat_id,
          isLobbyPane(pane)
            ? "🪄 <b>Lobby</b>\nYou’re back at the control layer. " +
              "Ask me to find, resume, rename, or start a Codex session."
            : `🪄 <b>Handoff complete</b> · now talking to ` +
              `<b>${normalizeAssistantName(pane.assistantName)}</b> in ` +
              `<b>${escapeTelegramHtml(pane.windowName)}</b>.`,
          undefined,
          undefined,
          attachment.message_thread_id || undefined,
        );
        if (!sent.ok) return false;
      }
      return true;
    }
    for (const attachment of attachments) {
      this.dependencies.store.setCodexAssistantNameForTarget(
        event.target,
        event.assistantName,
      );
      if (attachment.message_thread_id > 0) {
        const model = responseModelLabel(event);
        this.dependencies.store.updateTopicSetup(
          attachment.chat_id,
          attachment.owner_user_id,
          attachment.message_thread_id,
          {
            ...(model === "sol" || model === "luna" || model === "terra"
              ? { model }
              : {}),
            ...(event.reasoningEffort
              ? { reasoning_effort: event.reasoningEffort }
              : {}),
            ...(event.fast !== undefined ? { fast: event.fast ? 1 : 0 } : {}),
            ...(event.cwd ? { cwd: event.cwd } : {}),
          },
        );
      }
      if (
        event.kind === "state_compacting" ||
        event.kind === "state_working" ||
        event.kind === "state_waiting_terminal" ||
        event.kind === "state_activity"
      ) {
        if (
          event.kind === "state_working" ||
          event.kind === "state_waiting_terminal" ||
          event.kind === "state_activity"
        ) {
          await this.clearQueuedFollowupStatus(attachment, event.target);
        }
        await this.setTransientStatus(
          attachment,
          event.target,
          event.kind,
          undefined,
          undefined,
          event.message,
          false,
          event.assistantName,
        );
        continue;
      }
      if (event.kind === "turn_aborted") {
        const thinking = this.dependencies.store.codexThinkingSection(
          attachment.chat_id,
          attachment.owner_user_id,
          event.target,
        );
        await this.clearQueuedFollowupStatus(attachment, event.target);
        await this.setTransientStatus(
          attachment,
          event.target,
          "state_interrupted",
        );
        const rendered = this.dependencies.store.codexThinkingSection(
          attachment.chat_id,
          attachment.owner_user_id,
          event.target,
        );
        if (
          thinking &&
          rendered &&
          rendered.rendered_at >= thinking.updated_at
        ) {
          this.dependencies.store.clearCodexThinkingSection(
            attachment.chat_id,
            attachment.owner_user_id,
            event.target,
          );
        }
        continue;
      }
      if (event.kind === "agent_reasoning") {
        this.dependencies.store.appendCodexThinkingSummary(
          attachment.chat_id,
          attachment.owner_user_id,
          event.target,
          event.message,
        );
        await this.ensureDeferredTransientForThinking(
          attachment,
          event.target,
        );
        continue;
      }
      const finalHash = event.kind === "assistant_final"
        ? createHash("sha256").update(event.message).digest("hex")
        : null;
      if (
        finalHash &&
        this.dependencies.store.isRecentDuplicateCodexFinal(
          attachment.chat_id,
          attachment.owner_user_id,
          event.target,
          finalHash,
        )
      ) {
        continue;
      }
      if (event.kind === "context_compacted") {
        const thinking = this.dependencies.store.codexThinkingSection(
          attachment.chat_id,
          attachment.owner_user_id,
          event.target,
        );
        const goal = visibleCodexGoal(
          this.dependencies.store.codexGoal(
            attachment.chat_id,
            attachment.owner_user_id,
            attachment.message_thread_id,
          ),
        );
        const transient = this.takeTransientStatus(
          attachment,
          event.target,
        );
        const checkpoint = formatPromotedContextCompaction(
          this.profile(),
          thinking,
        );
        let delivered = false;
        if (transient) {
          const edited = await tgEditRichHtml(
            this.dependencies.env,
            attachment.chat_id,
            transient.telegram_message_id,
            checkpoint,
          ).catch(() => null);
          delivered = telegramEditSucceeded(edited);
          if (!delivered) {
            await tgDeleteMessage(
              this.dependencies.env,
              attachment.chat_id,
              transient.telegram_message_id,
            ).catch(() => undefined);
          }
        }
        if (!delivered) {
          const sent = await tgSendRichHtml(
            this.dependencies.env,
            attachment.chat_id,
            checkpoint,
            undefined,
            undefined,
            attachment.message_thread_id || undefined,
          );
          if (!sent.ok) return false;
        }
        if (thinking) {
          this.dependencies.store.clearCodexThinkingSection(
            attachment.chat_id,
            attachment.owner_user_id,
            event.target,
          );
        }
        if (goal) {
          await this.refreshGoalTransient(
            attachment,
            threadGoalFromRow(goal),
          );
        }
        continue;
      }
      if (event.kind === "image_viewed") {
        await this.clearQueuedFollowupStatus(attachment, event.target);
        await this.setTransientStatus(
          attachment,
          event.target,
          "state_image_viewed",
        );
        continue;
      }
      const storedGoalRowBeforeOutput = this.dependencies.store.codexGoal(
        attachment.chat_id,
        attachment.owner_user_id,
        attachment.message_thread_id,
      );
      const storedGoalBeforeOutput = visibleCodexGoal(
        storedGoalRowBeforeOutput,
      );
      const preserveGoalTransient = storedGoalBeforeOutput !== null;
      const preserveGoalEditor =
        storedGoalRowBeforeOutput?.awaiting_edit === 1;
      const outputThinking =
        event.kind === "assistant_progress" ||
          event.kind === "assistant_final" ||
          event.kind === "user_local"
          ? this.dependencies.store.codexThinkingSection(
            attachment.chat_id,
            attachment.owner_user_id,
            event.target,
          )
          : null;
      const transient = preserveGoalEditor
        ? this.dependencies.store.codexStatus(
          attachment.chat_id,
          attachment.owner_user_id,
          event.target,
        )
        : this.takeTransientStatus(attachment, event.target);
      const checkpointTransient = preserveGoalEditor ? null : transient;
      const pendingThrough = (
        event.kind === "assistant_final" ||
        event.kind === "assistant_progress"
      )
        ? this.dependencies.store.pendingCodexPromptsThrough(
            attachment.chat_id,
            attachment.owner_user_id,
            event.target,
            event.createdAt,
          )
        : [];
      const effectiveTurnStartedAt =
        event.turnStartedAt ||
        transient?.started_at ||
        event.createdAt;
      const pendingBatch = promptsReadByTurn(
        pendingThrough,
        effectiveTurnStartedAt,
      );
      const pending = event.kind === "assistant_final"
        ? pendingBatch[0]
        : event.kind === "assistant_progress"
          ? pendingBatch[pendingBatch.length - 1]
          : null;
      const turnStartedAt =
        pendingBatch[0]?.created_at ||
        effectiveTurnStartedAt;
      const turnElapsedMs = Math.max(0, event.createdAt - turnStartedAt);
      const totalWorkMs = event.kind === "assistant_final"
          ? this.dependencies.store.addCodexSessionWork(
            event.sessionId,
            event.turnId,
            turnElapsedMs,
          )
        : 0;
      const details = event.kind === "assistant_final"
        ? {
            model: responseModelLabel(event),
            reasoningEffort: event.reasoningEffort,
            fast: event.fast === true,
            cwd: event.cwd ?? attachment.cwd,
            turnElapsedMs,
            totalWorkMs,
            contextUsedPercent: event.contextUsedPercent,
          }
        : undefined;
      let deliveredAsRichMessage = false;
      let checkpointMessageId: number | null = null;
      let transientConsumed = false;
      const richMarkdown =
        event.kind === "assistant_final" ||
          event.kind === "assistant_progress"
          ? formatCodexRichMarkdown(
            event,
            details,
            this.profile(),
            outputThinking,
          )
          : null;
      if (richMarkdown !== null && richMarkdown.length <= 30_000) {
        const markdown = richMarkdown;
        if (checkpointTransient) {
          const edited = await tgEditRichMarkdown(
            this.dependencies.env,
            attachment.chat_id,
            checkpointTransient.telegram_message_id,
            markdown,
          ).catch(() => null);
          deliveredAsRichMessage = telegramEditSucceeded(edited);
          transientConsumed = deliveredAsRichMessage;
          if (event.kind === "assistant_final" && deliveredAsRichMessage) {
            checkpointMessageId = checkpointTransient.telegram_message_id;
          }
        } else {
          const richResult = await tgSendRichMarkdown(
            this.dependencies.env,
            attachment.chat_id,
            markdown,
            pending?.telegram_message_id,
            attachment.message_thread_id || undefined,
          ).catch(() => null);
          deliveredAsRichMessage = richResult?.ok === true;
          if (event.kind === "assistant_final" && richResult?.ok) {
            checkpointMessageId = richResult.result.message_id;
          }
        }
      }
      if (!deliveredAsRichMessage) {
        const chunks = formatCodexEvent(
          event,
          this.profile(),
          outputThinking,
        );
        for (let index = 0; index < chunks.length; index += 1) {
          let messageId: number | null = null;
          if (index === 0 && checkpointTransient && !transientConsumed) {
            const edited = await tgEditMessage(
              this.dependencies.env,
              attachment.chat_id,
              checkpointTransient.telegram_message_id,
              chunks[index],
            ).catch(() => null);
            if (telegramEditSucceeded(edited)) {
              transientConsumed = true;
              messageId = checkpointTransient.telegram_message_id;
            } else {
              await tgDeleteMessage(
                this.dependencies.env,
                attachment.chat_id,
                checkpointTransient.telegram_message_id,
              ).catch(() => undefined);
            }
          }
          if (messageId === null) {
            const result = await tgSend(
              this.dependencies.env,
              attachment.chat_id,
              chunks[index],
              index === 0 ? pending?.telegram_message_id : undefined,
              undefined,
              attachment.message_thread_id || undefined,
            );
            if (!result.ok) return false;
            messageId = result.result.message_id;
          }
          if (
            event.kind === "assistant_final" &&
            checkpointMessageId === null
          ) {
            checkpointMessageId = messageId;
          }
        }
      }
      if (
        event.kind === "assistant_progress" ||
        event.kind === "assistant_final"
      ) {
        this.beginPostResponseTransientGrace(attachment, event.target);
      }
      if (outputThinking) {
        this.dependencies.store.clearCodexThinkingSection(
          attachment.chat_id,
          attachment.owner_user_id,
          event.target,
        );
      }
      if (event.kind === "assistant_final") {
        this.dependencies.store.recordCodexFinalDelivery(
          attachment.chat_id,
          attachment.owner_user_id,
          event.target,
          finalHash!,
        );
        await this.dependencies.topicPresence?.markReady(attachment)
          .catch(() => undefined);
        if (
          attachment.message_thread_id > 0 &&
          checkpointMessageId !== null
        ) {
          // Telegram keeps multiple pins per topic and orders them itself.
          // Pinning is an enhancement: missing admin rights or a topic-side
          // limit must never make an otherwise delivered final retry.
          await tgPinChatMessage(
            this.dependencies.env,
            attachment.chat_id,
            checkpointMessageId,
          ).catch(() => undefined);
        }
      }
      if (preserveGoalTransient && !preserveGoalEditor) {
        await this.refreshGoalTransient(
          attachment,
          threadGoalFromRow(storedGoalBeforeOutput!),
        );
      }
      if (event.kind === "assistant_final" && pendingBatch.length > 0) {
        this.dependencies.store.markCodexPromptsDelivered(
          pendingBatch.map((row) => row.id),
        );
      }
    }
    return true;
  }

  private async routeForumHandoff(
    source: CodexAttachmentRow,
    requestedPane: CodexPane,
    kind: "navigate" | "created",
    panes: readonly CodexPane[],
  ): Promise<void> {
    if (kind === "created" && this.isTemporaryManagerGuide(source)) {
      await this.adoptSetupTopicWorker(source, requestedPane);
      return;
    }

    const manager = this.dependencies.store.managerTopic(source.chat_id);
    if (isLobbyPane(requestedPane) && manager) {
      const managerAttachment = this.dependencies.store.codexAttachment(
        source.chat_id,
        source.owner_user_id,
        manager.message_thread_id,
      );
      if (managerAttachment) {
        await this.sendTopicNavigation(source, managerAttachment);
        return;
      }
    }

    if (kind === "navigate") {
      const existing = this.dependencies.store
        .codexAttachmentsForTarget(requestedPane)
        .find((candidate) =>
          candidate.chat_id === source.chat_id &&
          candidate.owner_user_id === source.owner_user_id &&
          candidate.message_thread_id > 0
        );
      if (existing) {
        await this.sendTopicNavigation(source, existing);
        return;
      }
    }

    const livePane = panes.find((candidate) =>
      samePaneIdentity(candidate, requestedPane)
    ) ?? requestedPane;
    await this.createWorkerTopic(source, livePane);
  }

  private isTemporaryManagerGuide(source: CodexAttachmentRow): boolean {
    const manager = this.profile().manager;
    return source.cwd === manager.cwd &&
      source.window_name.startsWith(`${manager.name} · setup ·`) &&
      this.dependencies.store.managerTopic(source.chat_id)?.message_thread_id !==
        source.message_thread_id;
  }

  private async adoptSetupTopicWorker(
    source: CodexAttachmentRow,
    pane: CodexPane,
  ): Promise<void> {
    const renamed = await tgEditForumTopic(
      this.dependencies.env,
      source.chat_id,
      source.message_thread_id,
      pane.windowName,
    ).catch(() => null);
    if (!renamed?.ok) {
      await tgSend(
        this.dependencies.env,
        source.chat_id,
        "⚠️ The worker is ready, but this setup topic could not be renamed.",
        undefined,
        undefined,
        source.message_thread_id,
      ).catch(() => undefined);
      return;
    }
    this.dependencies.store.attachCodex(
      source.chat_id,
      source.owner_user_id,
      pane,
      source.message_thread_id,
    );
    this.dependencies.store.updateTopicSetup(
      source.chat_id,
      source.owner_user_id,
      source.message_thread_id,
      {
        topic_name: pane.windowName,
        cwd: pane.cwd,
        awaiting: "",
        idle_since: this.now(),
        closed_session_id: null,
        closed_at: null,
        resting_message_id: null,
      },
    );
    await tgSend(
      this.dependencies.env,
      source.chat_id,
      `🪄 <b>Setup complete</b> · now talking to ` +
        `<b>${normalizeAssistantName(pane.assistantName)}</b> in ` +
        `<b>${escapeTelegramHtml(pane.windowName)}</b>.`,
      undefined,
      undefined,
      source.message_thread_id,
    ).catch(() => undefined);
  }

  private async createWorkerTopic(
    source: CodexAttachmentRow,
    pane: CodexPane,
  ): Promise<void> {
    const created = await tgCreateForumTopic(
      this.dependencies.env,
      source.chat_id,
      pane.windowName,
    ).catch(() => null);
    if (!created?.ok) {
      await tgSend(
        this.dependencies.env,
        source.chat_id,
          "⚠️ <b>New topic could not be created.</b>\n" +
          `${escapeTelegramHtml(pane.windowName)} is running but remains ` +
          `unattached. Ask ${escapeTelegramHtml(this.profile().manager.name)} ` +
          "to reconnect it.",
        undefined,
        undefined,
        source.message_thread_id || undefined,
      ).catch(() => undefined);
      return;
    }

    const messageThreadId = created.result.message_thread_id;
    this.dependencies.store.rememberTopic(
      source.chat_id,
      source.owner_user_id,
      messageThreadId,
      pane.windowName,
      pane.cwd,
    );
    this.dependencies.store.attachCodex(
      source.chat_id,
      source.owner_user_id,
      pane,
      messageThreadId,
    );
    await tgSend(
      this.dependencies.env,
      source.chat_id,
      `🪄 <b>${escapeTelegramHtml(pane.windowName)}</b>\n` +
        `Now talking to ${normalizeAssistantName(pane.assistantName)}.`,
      undefined,
      undefined,
      messageThreadId,
    ).catch(() => undefined);
    await this.sendTopicNavigation(
      source,
      this.dependencies.store.codexAttachment(
        source.chat_id,
        source.owner_user_id,
        messageThreadId,
      )!,
      true,
    );
  }

  private async sendTopicNavigation(
    source: CodexAttachmentRow,
    destination: CodexAttachmentRow,
    created = false,
  ): Promise<void> {
    if (source.message_thread_id === destination.message_thread_id) {
      await tgSend(
        this.dependencies.env,
        source.chat_id,
        `✓ Already in <b>${escapeTelegramHtml(destination.window_name)}</b>.`,
        undefined,
        undefined,
        source.message_thread_id || undefined,
      ).catch(() => undefined);
      return;
    }
    const url = forumTopicUrl(
      destination.chat_id,
      destination.message_thread_id,
    );
    await tgSend(
      this.dependencies.env,
      source.chat_id,
      `${created ? "↗ <b>New task ready</b>" : "↗ <b>Chat ready</b>"} · ` +
        `${escapeTelegramHtml(destination.window_name)}`,
      undefined,
      url
        ? {
            inline_keyboard: [[{
              text: `Open ${destination.window_name}`.slice(0, 64),
              url,
            }]],
          }
        : undefined,
      source.message_thread_id || undefined,
    ).catch(() => undefined);
  }

  private async deliverGeneratedImage(
    event: CodexEvent,
    attachments: readonly CodexAttachmentRow[],
  ): Promise<boolean> {
    const deliveryKey = `${event.sessionId}:${path.basename(event.message)}`;
    if (
      this.dependencies.store.hasCodexGeneratedImageDelivery(deliveryKey)
    ) {
      removeStagedGeneratedImage(
        event.message,
        this.dependencies.env.DATA_DIR,
      );
      return true;
    }
    const pending = this.dependencies.store.latestPendingCodexPromptForTarget(
      event.target,
      event.createdAt,
      event.turnStartedAt ?? event.createdAt,
    );
    const attachment = pending
      ? attachments.find((candidate) =>
          candidate.chat_id === pending.chat_id &&
          candidate.owner_user_id === pending.owner_user_id &&
          candidate.message_thread_id === pending.message_thread_id
        )
      : undefined;
    if (!attachment || !pending) {
      removeStagedGeneratedImage(
        event.message,
        this.dependencies.env.DATA_DIR,
      );
      return true;
    }
    const generated = readStagedGeneratedImage(
      event.message,
      this.dependencies.env.DATA_DIR,
    );
    if (!generated) {
      removeStagedGeneratedImage(
        event.message,
        this.dependencies.env.DATA_DIR,
      );
      return true;
    }
    const sent = await tgSendPhoto(
      this.dependencies.env,
      attachment.chat_id,
      new Blob([Uint8Array.from(generated.bytes)], {
        type: generated.mimeType,
      }),
      "🎨 <b>Generated image</b>",
      undefined,
      attachment.message_thread_id || undefined,
      pending.telegram_message_id,
    ).catch(() => null);
    if (!sent?.ok) return false;
    this.dependencies.store.recordCodexGeneratedImageDelivery(
      deliveryKey,
      sent.result.message_id,
    );
    removeStagedGeneratedImage(
      event.message,
      this.dependencies.env.DATA_DIR,
    );
    return true;
  }

  private async flushDueThinkingSections(): Promise<void> {
    const due = this.dependencies.store.codexThinkingSectionsDue(
      this.now() - this.thinkingFlushIntervalMs,
    );
    for (const row of due) {
      const target: CodexPaneIdentity = {
        serverPid: row.server_pid,
        paneId: row.pane_id,
        panePid: row.pane_pid,
      };
      const attachment =
        this.dependencies.store.codexAttachmentForTarget(
          row.chat_id,
          row.owner_user_id,
          target,
        );
      if (!attachment) {
        this.dependencies.store.clearCodexThinkingSection(
          row.chat_id,
          row.owner_user_id,
          target,
        );
        continue;
      }
      await this.renderThinkingInTransient(attachment, target);
    }
  }

  private beginPostResponseTransientGrace(
    attachment: CodexAttachmentRow,
    target: CodexPaneIdentity,
  ): void {
    const key = codexOwnerTargetKey(
      attachment.chat_id,
      attachment.owner_user_id,
      target,
    );
    this.deferredTransientStarts.delete(key);
    this.transientGraceUntil.set(
      key,
      this.now() + this.postResponseTransientGraceMs,
    );
  }

  private clearPostResponseTransientGrace(
    attachment: CodexAttachmentRow,
    target: CodexPaneIdentity,
  ): void {
    const key = codexOwnerTargetKey(
      attachment.chat_id,
      attachment.owner_user_id,
      target,
    );
    this.deferredTransientStarts.delete(key);
    this.transientGraceUntil.delete(key);
  }

  private async ensureDeferredTransientForThinking(
    attachment: CodexAttachmentRow,
    target: CodexPaneIdentity,
  ): Promise<void> {
    const key = codexOwnerTargetKey(
      attachment.chat_id,
      attachment.owner_user_id,
      target,
    );
    if (
      this.dependencies.store.codexStatus(
        attachment.chat_id,
        attachment.owner_user_id,
        target,
      ) ||
      this.deferredTransientStarts.has(key) ||
      this.now() >= (this.transientGraceUntil.get(key) ?? 0)
    ) {
      return;
    }
    await this.setTransientStatus(
      attachment,
      target,
      "state_working",
    );
  }

  async flushDeferredTransientStartsOnce(): Promise<void> {
    const now = this.now();
    for (const [key, graceUntil] of this.transientGraceUntil) {
      if (graceUntil <= now) this.transientGraceUntil.delete(key);
    }
    for (const [key, pending] of this.deferredTransientStarts) {
      if (now < pending.dueAt) continue;
      if (this.deferredTransientStarts.get(key) !== pending) continue;
      const attachment =
        this.dependencies.store.codexAttachmentForTarget(
          pending.attachment.chat_id,
          pending.attachment.owner_user_id,
          pending.target,
        );
      if (
        !attachment ||
        attachment.message_thread_id !== pending.attachment.message_thread_id
      ) {
        this.deferredTransientStarts.delete(key);
        this.transientGraceUntil.delete(key);
        continue;
      }
      if (
        this.dependencies.store.codexStatus(
          attachment.chat_id,
          attachment.owner_user_id,
          pending.target,
        )
      ) {
        this.deferredTransientStarts.delete(key);
        this.transientGraceUntil.delete(key);
        continue;
      }
      this.deferredTransientStarts.delete(key);
      this.transientGraceUntil.delete(key);
      const expectedMutationVersion =
        (this.transientMutationVersions.get(key) ?? 0) + 1;
      await this.setTransientStatus(
        attachment,
        pending.target,
        pending.snapshot.statusKind as TransientStatusKind,
        undefined,
        undefined,
        undefined,
        true,
        undefined,
        true,
        pending.snapshot,
      );
      if (
        this.transientMutationVersions.get(key) === expectedMutationVersion &&
        !this.dependencies.store.codexStatus(
          attachment.chat_id,
          attachment.owner_user_id,
          pending.target,
        ) &&
        !this.deferredTransientStarts.has(key)
      ) {
        this.deferredTransientStarts.set(key, {
          ...pending,
          dueAt: now + this.transientRefreshIntervalMs,
        });
      }
    }
  }

  async refreshStaleTransientTimersOnce(): Promise<void> {
    const now = this.now();
    let panes: readonly CodexPane[] | null = null;
    for (const attachment of this.dependencies.store.codexAttachments()) {
      const target = attachmentTarget(attachment);
      const status = this.dependencies.store.codexStatus(
        attachment.chat_id,
        attachment.owner_user_id,
        target,
      );
      if (!status) continue;
      if (
        status.status_kind === "state_interrupting" &&
        now - status.updated_at >= 1_500
      ) {
        panes ??= await this.listPanes().catch(() => []);
        const pane = panes.find((candidate) =>
          samePaneIdentity(candidate, target)
        );
        if (!pane || !pane.busy) {
          await this.setTransientStatus(
            attachment,
            target,
            "state_interrupted",
          );
        }
        continue;
      }
      if (
        status.status_kind === "state_goal" ||
        status.status_kind === "state_interrupting" ||
        status.status_kind === "state_interrupted"
      ) {
        continue;
      }
      const key = codexOwnerTargetKey(
        attachment.chat_id,
        attachment.owner_user_id,
        target,
      );
      const lastRenderedAt =
        this.transientRenderedAt.get(key) ??
        this.transientTimerRenderedAt.get(key) ??
        status.updated_at;
      if (now - lastRenderedAt < this.transientRefreshIntervalMs) {
        continue;
      }
      if (
        !this.progressPacer.tryAcquire(
          attachment.chat_id,
          attachment.message_thread_id,
          now,
        )
      ) {
        continue;
      }
      const storedGoal = this.dependencies.store.codexGoal(
        attachment.chat_id,
        attachment.owner_user_id,
        attachment.message_thread_id,
      );
      if (storedGoal?.awaiting_edit === 1) continue;
      const mutation = this.beginTransientMutation(attachment, target);
      const goal = visibleCodexGoal(storedGoal);
      const thinking = this.dependencies.store.codexThinkingSection(
        attachment.chat_id,
        attachment.owner_user_id,
        target,
      );
      const snapshot = statusSnapshotFromRow(
        status,
        status.reply_to_message_id,
      );
      const keyboard = await this.transientControlKeyboard(
        attachment,
        goal,
      ).catch(() => undefined);
      if (!this.isCurrentTransientMutation(mutation)) continue;
      const edited = await tgEditRichHtml(
        this.dependencies.env,
        attachment.chat_id,
        status.telegram_message_id,
        formatCodexTransientRichHtml(
          snapshot,
          now,
          this.profile(),
          goal,
          thinking,
        ),
        keyboard,
      ).catch(() => null);
      if (
        this.isCurrentTransientMutation(mutation) &&
        telegramEditSucceeded(edited)
      ) {
        this.transientTimerRenderedAt.set(key, now);
        this.transientRenderedAt.set(key, now);
        if (thinking) {
          this.dependencies.store.markCodexThinkingSectionRendered(
            attachment.chat_id,
            attachment.owner_user_id,
            target,
            status.telegram_message_id,
          );
        }
      }
    }
  }

  private async renderThinkingInTransient(
    attachment: CodexAttachmentRow,
    target: CodexPaneIdentity,
  ): Promise<boolean> {
    const row = this.dependencies.store.codexThinkingSection(
      attachment.chat_id,
      attachment.owner_user_id,
      target,
    );
    if (!row) return true;
    const summaries = parseThinkingSummaries(row.summaries_json);
    if (summaries.length === 0) {
      this.dependencies.store.clearCodexThinkingSection(
        attachment.chat_id,
        attachment.owner_user_id,
        target,
      );
      return true;
    }
    if (
      !this.progressPacer.tryAcquire(
        attachment.chat_id,
        attachment.message_thread_id,
        this.now(),
      )
    ) {
      return true;
    }
    let transient = this.dependencies.store.codexStatus(
      attachment.chat_id,
      attachment.owner_user_id,
      target,
    );
    if (!transient) {
      await this.setTransientStatus(
        attachment,
        target,
        "state_working",
      );
      transient = this.dependencies.store.codexStatus(
        attachment.chat_id,
        attachment.owner_user_id,
        target,
      );
      if (!transient) return false;
      this.dependencies.store.markCodexThinkingSectionRendered(
        attachment.chat_id,
        attachment.owner_user_id,
        target,
        transient.telegram_message_id,
      );
      return true;
    }
    const storedGoal = this.dependencies.store.codexGoal(
      attachment.chat_id,
      attachment.owner_user_id,
      attachment.message_thread_id,
    );
    if (storedGoal?.awaiting_edit === 1) return true;
    const snapshot = statusSnapshotFromRow(
      transient,
      transient.reply_to_message_id,
    );
    const goal = visibleCodexGoal(storedGoal);
    const keyboard = await this.transientControlKeyboard(
      attachment,
      goal,
    ).catch(() => undefined);
    let edited = await tgEditRichHtml(
      this.dependencies.env,
      attachment.chat_id,
      transient.telegram_message_id,
      formatCodexTransientRichHtml(
        snapshot,
        this.now(),
        this.profile(),
        goal,
        row,
      ),
      keyboard,
    ).catch(() => null);
    if (!telegramEditSucceeded(edited)) {
      edited = await tgEditMessage(
        this.dependencies.env,
        attachment.chat_id,
        transient.telegram_message_id,
        formatCodexTransientFallback(
          snapshot,
          this.profile(),
          goal,
          row,
        ),
        keyboard,
      ).catch(() => null);
    }
    if (!telegramEditSucceeded(edited)) return false;
    this.dependencies.store.markCodexThinkingSectionRendered(
      attachment.chat_id,
      attachment.owner_user_id,
      target,
      transient.telegram_message_id,
    );
    this.progressPacer.record(
      attachment.chat_id,
      attachment.message_thread_id,
      this.now(),
    );
    this.transientRenderedAt.set(
      codexOwnerTargetKey(
        attachment.chat_id,
        attachment.owner_user_id,
        target,
      ),
      this.now(),
    );
    return true;
  }

  private async setTransientStatus(
    attachment: CodexAttachmentRow,
    target: CodexPaneIdentity,
    kind: TransientStatusKind,
    replyToMessageId?: number,
    queuedCount?: number,
    activityMessage?: string,
    preserveExisting = false,
    _assistantNameOverride?: CodexAssistantName,
    forceRender = false,
    snapshotOverride?: CodexStatusSnapshot,
  ): Promise<void> {
    if (kind === "state_interrupted") {
      await this.dependencies.topicPresence?.markReady(attachment)
        .catch(() => undefined);
    } else {
      await this.dependencies.topicPresence?.markWorking(attachment)
        .catch(() => undefined);
    }
    const mutation = this.beginTransientMutation(attachment, target);
    const existing = this.dependencies.store.codexStatus(
      attachment.chat_id,
      attachment.owner_user_id,
      target,
    );
    const deferred = this.deferredTransientStarts.get(mutation.key);
    const mergeBase = existing ?? (
      deferred
        ? transientStatusRowFromSnapshot(
          deferred.snapshot,
          attachment,
          target,
        )
        : null
    );
    const snapshot = snapshotOverride ?? mergeTransientStatus(
      mergeBase,
      kind,
      queuedCount,
      activityMessage,
      preserveExisting,
      replyToMessageId,
      this.now(),
    );
    const storedGoal = this.dependencies.store.codexGoal(
      attachment.chat_id,
      attachment.owner_user_id,
      attachment.message_thread_id,
    );
    const goal = visibleCodexGoal(storedGoal);
    const thinking = this.dependencies.store.codexThinkingSection(
      attachment.chat_id,
      attachment.owner_user_id,
      target,
    );
    const editingGoal = storedGoal?.awaiting_edit === 1
      ? storedGoal
      : null;
    if (editingGoal && existing) {
      if (!this.isCurrentTransientMutation(mutation)) return;
      this.dependencies.store.setCodexStatus(
        attachment.chat_id,
        attachment.owner_user_id,
        target,
        existing.telegram_message_id,
        snapshot,
      );
      return;
    }
    const graceUntil = this.transientGraceUntil.get(mutation.key) ?? 0;
    if (
      !existing &&
      !forceRender &&
      isDeferrableAfterResponse(kind) &&
      this.now() < graceUntil
    ) {
      if (!this.isCurrentTransientMutation(mutation)) return;
      this.deferredTransientStarts.set(mutation.key, {
        attachment,
        target,
        snapshot,
        dueAt: graceUntil,
      });
      return;
    }
    this.deferredTransientStarts.delete(mutation.key);
    if (graceUntil <= this.now()) {
      this.transientGraceUntil.delete(mutation.key);
    }
    if (
      existing &&
      isCoalescableTransientStatus(kind) &&
      !forceRender &&
      !this.progressPacer.tryAcquire(
        attachment.chat_id,
        attachment.message_thread_id,
        this.now(),
      )
    ) {
      if (!this.isCurrentTransientMutation(mutation)) return;
      this.dependencies.store.setCodexStatus(
        attachment.chat_id,
        attachment.owner_user_id,
        target,
        existing.telegram_message_id,
        snapshot,
      );
      return;
    }
    const html = editingGoal
      ? formatGoalEditPrompt(editingGoal)
      : formatCodexTransientRichHtml(
        snapshot,
        this.now(),
        this.profile(),
        goal,
        thinking,
      );
    const keyboard = editingGoal
      ? await this.goalEditKeyboard(
        attachment.chat_id,
        attachment.owner_user_id,
      ).catch(() => undefined)
      : await this.transientControlKeyboard(
        attachment,
        goal,
      ).catch(() => undefined);
    if (!this.isCurrentTransientMutation(mutation)) return;
    const renderedReplyTo = this.transientRenderedReplyTo.has(mutation.key)
      ? this.transientRenderedReplyTo.get(mutation.key)
      : existing?.reply_to_message_id;
    const shouldReanchor =
      existing !== null &&
      replyToMessageId !== undefined &&
      renderedReplyTo !== replyToMessageId;
    if (existing && !shouldReanchor) {
      const edited = await tgEditRichHtml(
        this.dependencies.env,
        attachment.chat_id,
        existing.telegram_message_id,
        html,
        keyboard,
      ).catch(() => null);
      if (telegramEditSucceeded(edited)) {
        if (!this.isCurrentTransientMutation(mutation)) return;
        this.dependencies.store.setCodexStatus(
          attachment.chat_id,
          attachment.owner_user_id,
          target,
          existing.telegram_message_id,
          snapshot,
        );
        this.transientRenderedAt.set(mutation.key, this.now());
        this.transientRenderedReplyTo.set(
          mutation.key,
          snapshot.replyToMessageId,
        );
        if (thinking) {
          this.dependencies.store.markCodexThinkingSectionRendered(
            attachment.chat_id,
            attachment.owner_user_id,
            target,
            existing.telegram_message_id,
          );
        }
        this.progressPacer.record(
          attachment.chat_id,
          attachment.message_thread_id,
          this.now(),
        );
        return;
      }
    }
    if (!this.isCurrentTransientMutation(mutation)) return;
    let sent = await tgSendRichHtml(
      this.dependencies.env,
      attachment.chat_id,
      html,
      snapshot.replyToMessageId ?? undefined,
      keyboard,
      attachment.message_thread_id || undefined,
    ).catch(() => null);
    if (!sent?.ok) {
      sent = await tgSend(
        this.dependencies.env,
        attachment.chat_id,
        formatCodexTransientFallback(
          snapshot,
          this.profile(),
          goal,
          thinking,
        ),
        snapshot.replyToMessageId ?? undefined,
        keyboard,
        attachment.message_thread_id || undefined,
      ).catch(() => null);
    }
    if (!sent?.ok) return;
    if (!this.isCurrentTransientMutation(mutation)) {
      await tgDeleteMessage(
        this.dependencies.env,
        attachment.chat_id,
        sent.result.message_id,
      ).catch(() => undefined);
      return;
    }
    this.dependencies.store.setCodexStatus(
      attachment.chat_id,
      attachment.owner_user_id,
      target,
      sent.result.message_id,
      snapshot,
    );
    this.transientRenderedAt.set(mutation.key, this.now());
    this.transientRenderedReplyTo.set(
      mutation.key,
      snapshot.replyToMessageId,
    );
    if (thinking) {
      this.dependencies.store.markCodexThinkingSectionRendered(
        attachment.chat_id,
        attachment.owner_user_id,
        target,
        sent.result.message_id,
      );
    }
    this.progressPacer.record(
      attachment.chat_id,
      attachment.message_thread_id,
      this.now(),
    );
    if (
      existing &&
      existing.telegram_message_id !== sent.result.message_id
    ) {
      await tgDeleteMessage(
        this.dependencies.env,
        attachment.chat_id,
        existing.telegram_message_id,
      ).catch(() => undefined);
    }
  }

  private async setQueuedFollowupStatus(
    attachment: CodexAttachmentRow,
    target: CodexPaneIdentity,
    replyToMessageId: number,
    addedCount: number,
  ): Promise<void> {
    const existing = this.dependencies.store.codexStatus(
      attachment.chat_id,
      attachment.owner_user_id,
      target,
    );
    const totalCount =
      (existing?.queued_messages ?? 0) + Math.max(1, addedCount);
    await this.setTransientStatus(
      attachment,
      target,
      "state_queued",
      replyToMessageId,
      totalCount,
      undefined,
      true,
    );
  }

  private beginTransientMutation(
    attachment: CodexAttachmentRow,
    target: CodexPaneIdentity,
  ): { readonly key: string; readonly version: number } {
    const key = codexOwnerTargetKey(
      attachment.chat_id,
      attachment.owner_user_id,
      target,
    );
    const version = (this.transientMutationVersions.get(key) ?? 0) + 1;
    this.transientMutationVersions.set(key, version);
    return { key, version };
  }

  private async transientControlKeyboard(
    attachment: CodexAttachmentRow,
    goal: CodexGoalRow | null,
  ): Promise<TelegramInlineKeyboardMarkup> {
    const interrupt = await issueCallbackReference(
      this.dependencies.store.callbackStore(),
      {
        action: "codex.transient_interrupt",
        chatId: attachment.chat_id,
        userId: attachment.owner_user_id,
        payload: {},
        ttlMs: CODEX_CALLBACK_TTL_MS,
      },
    );
    if (!goal || goal.status === "complete") {
      return buildInlineKeyboard([
        [{ label: "■  interrupt", callbackData: interrupt.callbackData }],
      ]);
    }
    const status = await issueCallbackReference(
      this.dependencies.store.callbackStore(),
      {
        action: goal.status === "active"
          ? "codex.goal_pause"
          : "codex.goal_resume",
        chatId: attachment.chat_id,
        userId: attachment.owner_user_id,
        payload: {},
        ttlMs: CODEX_CALLBACK_TTL_MS,
      },
    );
    const edit = await issueCallbackReference(
      this.dependencies.store.callbackStore(),
      {
        action: "codex.goal_edit",
        chatId: attachment.chat_id,
        userId: attachment.owner_user_id,
        payload: {},
        ttlMs: CODEX_CALLBACK_TTL_MS,
      },
    );
    const clear = await issueCallbackReference(
      this.dependencies.store.callbackStore(),
      {
        action: "codex.goal_clear",
        chatId: attachment.chat_id,
        userId: attachment.owner_user_id,
        payload: {},
        ttlMs: CODEX_CALLBACK_TTL_MS,
      },
    );
    return buildInlineKeyboard([
      [
        { label: "■  interrupt", callbackData: interrupt.callbackData },
        {
          label: goal.status === "active" ? "Ⅱ  pause goal" : "▶  resume goal",
          callbackData: status.callbackData,
        },
      ],
      [
        { label: "✎  edit", callbackData: edit.callbackData },
        { label: "×  clear", callbackData: clear.callbackData },
      ],
    ]);
  }

  private isCurrentTransientMutation(
    mutation: { readonly key: string; readonly version: number },
  ): boolean {
    return this.transientMutationVersions.get(mutation.key) === mutation.version;
  }

  private takeTransientStatus(
    attachment: CodexAttachmentRow,
    target: CodexPaneIdentity,
  ): CodexStatusRow | null {
    const mutation = this.beginTransientMutation(attachment, target);
    this.deferredTransientStarts.delete(mutation.key);
    this.transientGraceUntil.delete(mutation.key);
    this.transientRenderedAt.delete(mutation.key);
    this.transientTimerRenderedAt.delete(mutation.key);
    this.transientRenderedReplyTo.delete(mutation.key);
    return this.dependencies.store.clearCodexStatus(
      attachment.chat_id,
      attachment.owner_user_id,
      target,
    );
  }

  private async clearQueuedFollowupStatus(
    attachment: CodexAttachmentRow,
    target: CodexPaneIdentity,
  ): Promise<void> {
    const queued = this.dependencies.store.clearCodexQueueStatus(
      attachment.chat_id,
      attachment.owner_user_id,
      target,
    );
    const transient = this.dependencies.store.codexStatus(
      attachment.chat_id,
      attachment.owner_user_id,
      target,
    );
    if (
      queued &&
      queued.telegram_message_id !== transient?.telegram_message_id
    ) {
      await tgDeleteMessage(
        this.dependencies.env,
        attachment.chat_id,
        queued.telegram_message_id,
      ).catch(() => undefined);
    }
  }

  private async sendMenu(
    chatId: number,
    ownerUserId: number,
    replyToMessageId?: number,
    messageThreadId = 0,
  ): Promise<void> {
    try {
      const menu = await this.buildMenu(chatId, ownerUserId, messageThreadId);
      await tgSend(
        this.dependencies.env,
        chatId,
        menu.text,
        replyToMessageId,
        menu.keyboard,
        messageThreadId || undefined,
      );
    } catch {
      await tgSend(
        this.dependencies.env,
        chatId,
        "⚠️ The session bridge is unavailable. Try <code>/codex</code> again shortly.",
        replyToMessageId,
        undefined,
        messageThreadId || undefined,
      );
    }
  }

  private async editMenu(
    chatId: number,
    ownerUserId: number,
    messageId: number,
    messageThreadId = 0,
  ): Promise<void> {
    try {
      const menu = await this.buildMenu(chatId, ownerUserId, messageThreadId);
      await tgEditMessage(
        this.dependencies.env,
        chatId,
        messageId,
        menu.text,
        menu.keyboard,
      );
    } catch {
      await this.editError(
        chatId,
        messageId,
        "The session bridge is unavailable. Try again shortly.",
      );
    }
  }

  private async editError(
    chatId: number,
    messageId: number,
    message: string,
  ): Promise<void> {
    await tgEditMessage(
      this.dependencies.env,
      chatId,
      messageId,
      message,
    ).catch(() => undefined);
  }

  private async buildMenu(
    chatId: number,
    ownerUserId: number,
    messageThreadId = 0,
  ): Promise<Menu> {
    const { panes, recent } = await this.listSessions();
    const attachment = this.dependencies.store.codexAttachment(
      chatId,
      ownerUserId,
      messageThreadId,
    );
    let activePane = attachment
      ? panes.find((pane) =>
          samePaneIdentity(pane, attachmentTarget(attachment)),
        )
      : undefined;
    if (attachment && !activePane && chatId > 0) {
      activePane = await this.attachLobby(
        chatId,
        ownerUserId,
        messageThreadId,
      ) ?? undefined;
    }

    const rows: InlineKeyboardButtonInput[][] = [];
    const orderedPanes = [...panes].sort(
      (left, right) =>
        Number(isLobbyPane(right)) - Number(isLobbyPane(left)),
    );
    const visiblePanes = orderedPanes.slice(0, 12);
    for (const pane of visiblePanes) {
      const attached = activePane && samePaneIdentity(activePane, pane);
      const issued = await issueCallbackReference(
        this.dependencies.store.callbackStore(),
        {
          action: "codex.attach",
          chatId,
          userId: ownerUserId,
          payload: { target: paneIdentityPayload(pane) },
          ttlMs: CODEX_CALLBACK_TTL_MS,
        },
      );
      rows.push([
        {
          label: sessionButtonLabel(pane, Boolean(attached)),
          callbackData: issued.callbackData,
        },
      ]);
    }
    const runningSessionIds = new Set(
      panes.flatMap((pane) => pane.sessionId ? [pane.sessionId] : []),
    );
    const resumable = recent
      .filter((session) => !runningSessionIds.has(session.id))
      .slice(0, 5);
    for (const session of resumable) {
      const issued = await issueCallbackReference(
        this.dependencies.store.callbackStore(),
        {
          action: "codex.resume",
          chatId,
          userId: ownerUserId,
          payload: { id: session.id, name: session.name },
          ttlMs: CODEX_CALLBACK_TTL_MS,
        },
      );
      rows.push([
        {
          label: `↩ ${truncateVisible(session.name, 48)}`,
          callbackData: issued.callbackData,
        },
      ]);
    }
    const newAction = await this.issueAction("codex.new", chatId, ownerUserId);
    const refreshAction = await this.issueAction(
      "codex.refresh",
      chatId,
      ownerUserId,
    );
    rows.push([
      { label: "＋ New session", callbackData: newAction },
      { label: "↻ Refresh", callbackData: refreshAction },
    ]);
    if (activePane) {
      const screenAction = await this.issueAction(
        "codex.screen",
        chatId,
        ownerUserId,
      );
      const interruptAction = await this.issueAction(
        "codex.interrupt",
        chatId,
        ownerUserId,
      );
      const detachAction = await this.issueAction(
        "codex.detach",
        chatId,
        ownerUserId,
      );
      rows.push([
        { label: "🖥 Screen", callbackData: screenAction },
        { label: "■ Interrupt", callbackData: interruptAction },
        ...(!isLobbyPane(activePane)
          ? [{ label: "🪄 Lobby", callbackData: detachAction }]
          : []),
      ]);
    }

    const lines = ["🪄 <b>Chatinabox</b> · sessions", ""];
    if (activePane && isLobbyPane(activePane)) {
      lines.push(
        "<b>🪄 Lobby</b> · control layer",
        "",
        "Ask naturally to find, resume, rename, or start a worker. " +
          "New sessions default to <b>Sol · high</b>.",
      );
    } else if (activePane) {
      lines.push(
        `<b>${activePane.busy ? "⏳ Working" : "● Ready"}</b> · ` +
          `<b>${normalizeAssistantName(activePane.assistantName)}</b>`,
        `<b>${escapeTelegramHtml(activePane.windowName)}</b>`,
        `<code>${escapeTelegramHtml(activePane.cwd)}</code>`,
        "",
        "Messages and unknown slash commands go straight to this session.",
      );
    } else {
      lines.push(
        panes.length > 0
          ? "Pick a running session below, or start a new one."
          : "No running Codex session was found. Start one below.",
      );
    }
    if (resumable.length > 0) {
      lines.push(
        "",
        "<b>Recent chats</b> — tap ↩ to resume one in tmux.",
      );
    }
    if (orderedPanes.length > visiblePanes.length) {
      lines.push(
        "",
        `${orderedPanes.length - visiblePanes.length} more running ` +
          `${orderedPanes.length - visiblePanes.length === 1 ? "session" : "sessions"} · ` +
          "use <code>/attach name</code>",
      );
    }
    lines.push(
      "",
      "<code>/codex new name</code> · <code>/codex rename name</code> · " +
        "<code>/help</code>",
    );
    return { text: lines.join("\n"), keyboard: buildInlineKeyboard(rows) };
  }

  private async issueAction(
    action:
      | "codex.new"
      | "codex.refresh"
      | "codex.detach"
      | "codex.interrupt"
      | "codex.screen",
    chatId: number,
    ownerUserId: number,
  ) {
    return (
      await issueCallbackReference(this.dependencies.store.callbackStore(), {
        action,
        chatId,
        userId: ownerUserId,
        payload: {},
        ttlMs: CODEX_CALLBACK_TTL_MS,
      })
    ).callbackData;
  }

  private async listPanes(): Promise<readonly CodexPane[]> {
    return (await this.listSessions()).panes;
  }

  private async listSessions(): Promise<{
    readonly panes: readonly CodexPane[];
    readonly recent: readonly CodexRecentSession[];
  }> {
    const response = await this.bridge.request({ op: "list" });
    if (!response.ok) throw new Error(response.error);
    return "panes" in response
      ? { panes: response.panes, recent: response.recent }
      : { panes: [], recent: [] };
  }

  private async attachByArgument(
    chatId: number,
    ownerUserId: number,
    argument: string,
    replyToMessageId: number,
    messageThreadId = 0,
  ): Promise<void> {
    const panes = await this.listPanes().catch(() => []);
    const pane = resolvePaneArgument(panes, argument);
    if (!pane) {
      if (argument.trim()) {
        const selection = truncateVisible(argument.trim(), 120);
        await tgSend(
          this.dependencies.env,
          chatId,
          `No unique session matched <code>${escapeTelegramHtml(selection)}</code>.`,
          replyToMessageId,
          undefined,
          messageThreadId || undefined,
        );
      }
      await this.sendMenu(
        chatId,
        ownerUserId,
        replyToMessageId,
        messageThreadId,
      );
      return;
    }
    const source = this.dependencies.store.codexAttachment(
      chatId,
      ownerUserId,
      messageThreadId,
    );
    if (chatId < 0 && messageThreadId > 0 && source) {
      await this.routeForumHandoff(source, pane, "navigate", panes);
      return;
    }
    this.dependencies.store.attachCodex(
      chatId,
      ownerUserId,
      pane,
      messageThreadId,
    );
    const assistantName = normalizeAssistantName(pane.assistantName);
    await tgSend(
      this.dependencies.env,
      chatId,
      `✅ Connected to <b>${assistantName}</b> in ` +
        `<b>${escapeTelegramHtml(pane.windowName)}</b>.\n` +
      `Send a normal message to talk to ${assistantName}. ` +
        `Use <code>/detach</code> when finished.`,
      replyToMessageId,
      undefined,
      messageThreadId || undefined,
    );
  }

  private async detach(
    chatId: number,
    ownerUserId: number,
    replyToMessageId: number,
    messageThreadId = 0,
  ): Promise<void> {
    const source = this.dependencies.store.codexAttachment(
      chatId,
      ownerUserId,
      messageThreadId,
    );
    if (chatId < 0 && messageThreadId > 0 && source) {
      const manager = this.dependencies.store.managerTopic(chatId);
      const managerAttachment = manager
        ? this.dependencies.store.codexAttachment(
            chatId,
            ownerUserId,
            manager.message_thread_id,
          )
        : null;
      if (managerAttachment) {
        await this.sendTopicNavigation(source, managerAttachment);
      } else {
        await tgSend(
          this.dependencies.env,
          chatId,
          `⚠️ ${escapeTelegramHtml(this.profile().manager.name)} is not ` +
            "connected. Send <code>/manager wake</code> in its topic.",
          replyToMessageId,
          undefined,
          messageThreadId,
        );
      }
      return;
    }
    const lobby = await this.attachLobby(
      chatId,
      ownerUserId,
      messageThreadId,
    );
    await tgSend(
      this.dependencies.env,
      chatId,
      lobby
        ? "🪄 <b>Lobby</b>\nYou’re back at the control layer. Ask me to find, " +
          "resume, rename, or start a Codex session."
        : "⚠️ Lobby could not start. Open <code>/codex</code> to reconnect.",
      replyToMessageId,
      undefined,
      messageThreadId || undefined,
    );
  }

  private async attachLobby(
    chatId: number,
    ownerUserId: number,
    messageThreadId = 0,
  ): Promise<CodexPane | null> {
    const response = await this.bridge.request({ op: "lobby" }).catch(() => null);
    if (!response?.ok || !("pane" in response)) return null;
    this.dependencies.store.attachCodex(
      chatId,
      ownerUserId,
      response.pane,
      messageThreadId,
    );
    return response.pane;
  }

  private async turnOff(
    chatId: number,
    ownerUserId: number,
    replyToMessageId: number,
    messageThreadId = 0,
  ): Promise<void> {
    const detached = this.dependencies.store.detachCodex(
      chatId,
      ownerUserId,
      messageThreadId,
    );
    await tgSend(
      this.dependencies.env,
      chatId,
      detached
        ? "○ Chatinabox routing is off. Your next message will wake the Lobby."
        : "Chatinabox routing is already off.",
      replyToMessageId,
      undefined,
      messageThreadId || undefined,
    );
  }

  private async createAndAttach(
    chatId: number,
    ownerUserId: number,
    name: string | undefined,
    replyToMessageId: number,
    messageThreadId = 0,
  ): Promise<void> {
    const result = await this.bridge.request({
      op: "new",
      ...(name ? { name } : {}),
      cwd: this.dependencies.env.DEFAULT_CWD,
      ...workerDefaults(this.profile()),
    }).catch(() => null);
    if (!result?.ok || !("pane" in result)) {
      await tgSend(
        this.dependencies.env,
        chatId,
        result && !result.ok
          ? `⚠️ ${escapeTelegramHtml(result.error)}`
          : "⚠️ The session bridge is unavailable.",
        replyToMessageId,
        undefined,
        messageThreadId || undefined,
      );
      return;
    }
    const source = this.dependencies.store.codexAttachment(
      chatId,
      ownerUserId,
      messageThreadId,
    );
    if (chatId < 0 && messageThreadId > 0 && source) {
      await this.routeForumHandoff(
        source,
        result.pane,
        "created",
        await this.listPanes().catch(() => [result.pane]),
      );
      return;
    }
    this.dependencies.store.attachCodex(
      chatId,
      ownerUserId,
      result.pane,
      messageThreadId,
    );
    const assistantName = normalizeAssistantName(result.pane.assistantName);
    await tgSend(
      this.dependencies.env,
      chatId,
      `✅ Started and connected to <b>${assistantName}</b> in ` +
        `<b>${escapeTelegramHtml(result.pane.windowName)}</b>.\n` +
        "Send your first message whenever you're ready.",
      replyToMessageId,
      undefined,
      messageThreadId || undefined,
    );
  }

  private async rename(
    chatId: number,
    ownerUserId: number,
    rawName: string,
    replyToMessageId: number,
    messageThreadId = 0,
  ): Promise<void> {
    const attachment = this.dependencies.store.codexAttachment(
      chatId,
      ownerUserId,
      messageThreadId,
    );
    const name = normalizeName(rawName);
    if (!attachment || !name) {
      await tgSend(
        this.dependencies.env,
        chatId,
        attachment
          ? "Use <code>/codex rename descriptive name</code>."
          : "Attach a session with <code>/codex</code> first.",
        replyToMessageId,
        undefined,
        messageThreadId || undefined,
      );
      return;
    }
    const result = await this.bridge.request({
      op: "rename",
      target: attachmentTarget(attachment),
      name,
    }).catch(() => null);
    if (!result?.ok || !("pane" in result)) {
      await tgSend(
        this.dependencies.env,
        chatId,
        result && !result.ok
          ? `⚠️ ${escapeTelegramHtml(result.error)}`
          : "⚠️ The session bridge is unavailable.",
        replyToMessageId,
        undefined,
        messageThreadId || undefined,
      );
      return;
    }
    this.dependencies.store.renameAttachedCodexTarget(
      attachmentTarget(attachment),
      result.pane,
    );
    await tgSend(
      this.dependencies.env,
      chatId,
      `✅ Renamed this session to <b>${escapeTelegramHtml(result.pane.windowName)}</b>.`,
      replyToMessageId,
      undefined,
      messageThreadId || undefined,
    );
  }

  private async interrupt(
    chatId: number,
    ownerUserId: number,
    replyToMessageId: number,
    messageThreadId = 0,
  ): Promise<void> {
    const attachment = this.dependencies.store.codexAttachment(
      chatId,
      ownerUserId,
      messageThreadId,
    );
    if (!attachment) {
      await tgSend(
        this.dependencies.env,
        chatId,
        "Attach a session with <code>/codex</code> first.",
        replyToMessageId,
        undefined,
        messageThreadId || undefined,
      );
      return;
    }
    const result = await this.bridge.request({
      op: "interrupt",
      target: attachmentTarget(attachment),
    }).catch(() => null);
    await tgSend(
      this.dependencies.env,
      chatId,
      result?.ok
        ? `■ Interrupt sent to ${normalizeAssistantName(attachment.assistant_name)}.`
        : `⚠️ That ${normalizeAssistantName(attachment.assistant_name)} session could not be interrupted.`,
      replyToMessageId,
      undefined,
      messageThreadId || undefined,
    );
  }

  private async sendScreen(
    chatId: number,
    ownerUserId: number,
    replyToMessageId?: number,
    replacement?: ScreenReplacement,
    captureDelayMs = 0,
    messageThreadId = 0,
  ): Promise<void> {
    const attachment = this.dependencies.store.codexAttachment(
      chatId,
      ownerUserId,
      messageThreadId,
    );
    if (!attachment) {
      await tgSend(
        this.dependencies.env,
        chatId,
        "Attach a session with <code>/codex</code> first.",
        replyToMessageId,
        undefined,
        messageThreadId || undefined,
      );
      return;
    }
    const keyboard = await this.buildScreenKeyboard(chatId, ownerUserId);
    if (replacement) {
      await this.editScreenPlaceholder(
        chatId,
        replacement,
        "⏳ <b>Updating terminal view…</b>",
        keyboard,
      );
    }
    if (captureDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, captureDelayMs));
    }
    const response = await this.bridge.request({
      op: "screen",
      target: attachmentTarget(attachment),
    }).catch(() => null);
    if (!response?.ok || !("screen" in response)) {
      const errorText =
        response && !response.ok
          ? `⚠️ ${escapeTelegramHtml(response.error)}`
          : "⚠️ Could not capture the Codex terminal.";
      if (replacement) {
        await this.editScreenPlaceholder(
          chatId,
          replacement,
          errorText,
          keyboard,
        );
      } else {
        await tgSend(
          this.dependencies.env,
          chatId,
          errorText,
          replyToMessageId,
          undefined,
          messageThreadId || undefined,
        );
      }
      return;
    }
    const image = new Blob(
      [Buffer.from(response.screen.imageBase64, "base64")],
      { type: "image/png" },
    );
    const updatedAt = new Date(response.screen.capturedAt)
      .toISOString()
      .slice(11, 19);
    const caption =
      `🖥 <b>${escapeTelegramHtml(displayName(attachment))}</b>\n` +
      `${updatedAt} UTC · tap a key to send it and refresh`;
    let sent = replacement
      ? await tgEditPhotoMedia(
          this.dependencies.env,
          chatId,
          replacement.messageId,
          image,
          caption,
          keyboard,
        )
      : await tgSendPhoto(
          this.dependencies.env,
          chatId,
          image,
          caption,
          keyboard,
          messageThreadId || undefined,
        );
    if (!sent.ok && replacement) {
      sent = await tgSendPhoto(
        this.dependencies.env,
        chatId,
        image,
        caption,
        keyboard,
        messageThreadId || undefined,
      );
      if (sent.ok) {
        await tgDeleteMessage(
          this.dependencies.env,
          chatId,
          replacement.messageId,
        ).catch(() => undefined);
      }
    }
    if (!sent.ok) {
      await tgSend(
        this.dependencies.env,
        chatId,
        "⚠️ Telegram could not display the terminal screenshot.",
        replyToMessageId,
        undefined,
        messageThreadId || undefined,
      );
    }
  }

  private async editScreenPlaceholder(
    chatId: number,
    replacement: ScreenReplacement,
    text: string,
    keyboard: TelegramInlineKeyboardMarkup,
  ): Promise<void> {
    const edit = replacement.isPhoto
      ? tgEditMessageCaption(
          this.dependencies.env,
          chatId,
          replacement.messageId,
          text,
          keyboard,
        )
      : tgEditMessage(
          this.dependencies.env,
          chatId,
          replacement.messageId,
          text,
          keyboard,
        );
    await edit.catch(() => undefined);
  }

  private async sendKeyCommand(
    chatId: number,
    ownerUserId: number,
    argument: string,
    replyToMessageId: number,
    messageThreadId = 0,
  ): Promise<void> {
    const keys = parseKeyCommand(argument);
    if (!keys) {
      await tgSend(
        this.dependencies.env,
        chatId,
        "Unknown key. Use <code>/help</code> for the complete key list " +
          "and multi-key examples.",
        replyToMessageId,
        undefined,
        messageThreadId || undefined,
      );
      return;
    }
    const sent = await this.sendKeys(
      chatId,
      ownerUserId,
      keys,
      replyToMessageId,
      messageThreadId,
    );
    if (sent) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await this.sendScreen(
        chatId,
        ownerUserId,
        undefined,
        undefined,
        0,
        messageThreadId,
      );
    }
  }

  private async sendKeys(
    chatId: number,
    ownerUserId: number,
    keys: readonly string[],
    replyToMessageId?: number,
    messageThreadId = 0,
  ): Promise<boolean> {
    const attachment = this.dependencies.store.codexAttachment(
      chatId,
      ownerUserId,
      messageThreadId,
    );
    if (!attachment) {
      await tgSend(
        this.dependencies.env,
        chatId,
        "Attach a session with <code>/codex</code> first.",
        replyToMessageId,
        undefined,
        messageThreadId || undefined,
      );
      return false;
    }
    const result = await this.bridge.request({
      op: "keys",
      target: attachmentTarget(attachment),
      keys,
    }).catch(() => null);
    if (!result?.ok) {
      await tgSend(
        this.dependencies.env,
        chatId,
        result && !result.ok
          ? `⚠️ ${escapeTelegramHtml(result.error)}`
          : "⚠️ Could not send that terminal key.",
        replyToMessageId,
        undefined,
        messageThreadId || undefined,
      );
      return false;
    }
    return true;
  }

  private async buildScreenKeyboard(
    chatId: number,
    ownerUserId: number,
  ): Promise<TelegramInlineKeyboardMarkup> {
    const keyButton = async (
      label: string,
      key: string,
    ): Promise<InlineKeyboardButtonInput> => ({
      label,
      callbackData: (
        await issueCallbackReference(
          this.dependencies.store.callbackStore(),
          {
            action: "codex.key",
            chatId,
            userId: ownerUserId,
            payload: { key },
            ttlMs: CODEX_CALLBACK_TTL_MS,
          },
        )
      ).callbackData,
    });
    const refresh = await issueCallbackReference(
      this.dependencies.store.callbackStore(),
      {
        action: "codex.screen",
        chatId,
        userId: ownerUserId,
        payload: {},
        ttlMs: CODEX_CALLBACK_TTL_MS,
      },
    );
    return buildInlineKeyboard([
      [
        await keyButton("Esc", "esc"),
        await keyButton("↑", "up"),
        await keyButton("Enter", "enter"),
      ],
      [
        await keyButton("←", "left"),
        await keyButton("↓", "down"),
        await keyButton("→", "right"),
      ],
      [
        await keyButton("Tab", "tab"),
        await keyButton("PgUp", "pageup"),
        await keyButton("PgDn", "pagedown"),
      ],
      [
        await keyButton("Ctrl-C", "ctrl-c"),
        { label: "↻ Refresh", callbackData: refresh.callbackData },
      ],
    ]);
  }
}

function codexOwnerTargetKey(
  chatId: number,
  ownerUserId: number,
  target: CodexPaneIdentity,
): string {
  return [
    chatId,
    ownerUserId,
    target.serverPid,
    target.paneId,
    target.panePid,
  ].join("\u001f");
}

export function telegramMessageThreadId(
  message: Pick<TelegramMessage, "message_thread_id">,
): number {
  return Number.isSafeInteger(message.message_thread_id) &&
      message.message_thread_id! > 0
    ? message.message_thread_id!
    : 0;
}

function parseCodexOwnerTargetKey(value: string): {
  readonly chatId: number;
  readonly ownerUserId: number;
  readonly target: CodexPaneIdentity;
} | null {
  const fields = value.split("\u001f");
  if (fields.length !== 5) return null;
  const chatId = Number(fields[0]);
  const ownerUserId = Number(fields[1]);
  const target = {
    serverPid: Number(fields[2]),
    paneId: fields[3],
    panePid: Number(fields[4]),
  };
  return isTelegramIdentity(chatId, false) &&
      isTelegramIdentity(ownerUserId, true) &&
      isPaneIdentity(target)
    ? { chatId, ownerUserId, target }
    : null;
}

export function buildBundledTelegramPrompt(
  messages: readonly string[],
): string {
  if (messages.length === 1) return messages[0];
  return [
    "The user sent these Telegram messages together. Treat them as one follow-up, preserving their order.",
    "",
    ...messages.flatMap((message, index) => [
      `--- Message ${index + 1} ---`,
      message,
      "",
    ]),
  ].join("\n").trimEnd();
}

export function buildTelegramTextPrompt(message: TelegramMessage): string {
  const text = message.text?.trim() ?? "";
  const repliedTo =
    message.reply_to_message?.text?.trim() ||
    message.reply_to_message?.caption?.trim();
  if (!repliedTo) return text;

  const sender = message.reply_to_message?.from;
  const senderName =
    sender?.first_name?.trim() ||
    (sender?.username ? `@${sender.username}` : "") ||
    (sender?.is_bot ? "Chatinabox" : "Earlier message");
  const snippet = truncateVisible(
    repliedTo.replace(/\s+/gu, " "),
    280,
  );
  return [
    `Sent from Telegram in reply to ${senderName}:`,
    `“${snippet}”`,
    "",
    text,
  ].join("\n");
}

export function promptsReadByTurn(
  prompts: readonly CodexPromptRow[],
  turnStartedAt: number,
): CodexPromptRow[] {
  return prompts.filter(
    (prompt) =>
      prompt.queued_for_next_turn !== 1 ||
      prompt.created_at <= turnStartedAt,
  );
}

export function voiceTranscriptReceiptHtml(
  transcript: string,
): string[] {
  const characters = Array.from(transcript);
  const chunks: string[] = [];
  for (let offset = 0; offset < characters.length; offset += 2_800) {
    const text = characters.slice(offset, offset + 2_800).join("");
    chunks.push(
      `<p><b>🎙️ Transcript${offset === 0 ? "" : " · continued"}</b></p>` +
        `<pre>${escapeTelegramHtml(text)}</pre>`,
    );
  }
  return chunks.length > 0
    ? chunks
    : ["<p><b>🎙️ Transcript</b></p><pre></pre>"];
}

function readStagedGeneratedImage(
  filePath: string,
  dataDirectory: string,
): {
  readonly bytes: Buffer;
  readonly mimeType: "image/png" | "image/jpeg";
} | null {
  const root = safeRealpath(path.join(dataDirectory, "generated-images"));
  const candidate = safeRealpath(filePath);
  if (!root || !candidate || !candidate.startsWith(`${root}${path.sep}`)) {
    return null;
  }
  try {
    const stats = statSync(candidate);
    if (!stats.isFile() || stats.size < 1 || stats.size > 10 * 1024 * 1024) {
      return null;
    }
    const bytes = readFileSync(candidate);
    if (
      bytes.byteLength >= 8 &&
      bytes.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      )
    ) {
      return { bytes, mimeType: "image/png" };
    }
    if (
      bytes.byteLength >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff
    ) {
      return { bytes, mimeType: "image/jpeg" };
    }
  } catch {
    return null;
  }
  return null;
}

function removeStagedGeneratedImage(
  filePath: string,
  dataDirectory: string,
): void {
  const root = safeRealpath(path.join(dataDirectory, "generated-images"));
  const candidate = safeRealpath(filePath);
  if (root && candidate?.startsWith(`${root}${path.sep}`)) {
    rmSync(candidate, { force: true });
  }
}

function safeRealpath(filePath: string): string | null {
  try {
    return realpathSync(filePath);
  } catch {
    return null;
  }
}

export function mergeTransientStatus(
  existing: CodexStatusRow | null,
  kind: TransientStatusKind,
  queuedCount: number | undefined,
  activityMessage: string | undefined,
  preserveExisting: boolean,
  replyToMessageId: number | undefined,
  now: number,
): CodexStatusSnapshot {
  let statusKind = existing?.status_kind ?? "state_working";
  let toolCalls = existing?.tool_calls ?? 0;
  let editedFiles = existing?.edited_files ?? 0;
  let exploredThings = existing?.explored_things ?? 0;
  let activeShells = existing?.active_shells ?? 0;
  let queuedMessages = existing?.queued_messages ?? 0;
  let startedAt = existing?.started_at || now;

  const preserveCurrentTurn =
    preserveExisting &&
    existing !== null &&
    existing.status_kind !== "state_interrupting" &&
    existing.status_kind !== "state_interrupted";

  if (kind === "state_queued") {
    queuedMessages = safeStatusCount(queuedCount ?? 1);
  } else if (!preserveCurrentTurn) {
    statusKind = kind;
    if (kind === "state_working") {
      toolCalls = 0;
      editedFiles = 0;
      exploredThings = 0;
      activeShells = 0;
      startedAt = now;
    }
    if (
      kind === "state_working" ||
      kind === "state_activity" ||
      kind === "state_waiting_terminal" ||
      kind === "state_image_viewed"
    ) {
      queuedMessages = 0;
    }
  }

  if (kind === "state_activity") {
    const counters = parseActivityCounters(activityMessage ?? "");
    if (counters) {
      toolCalls = counters.toolCalls;
      editedFiles = counters.editedFiles;
      exploredThings = counters.exploredThings;
      activeShells = counters.activeShells;
    }
  }

  return {
    statusKind,
    toolCalls,
    editedFiles,
    exploredThings,
    activeShells,
    queuedMessages,
    replyToMessageId:
      replyToMessageId ?? existing?.reply_to_message_id ?? null,
    startedAt,
  };
}

function transientStatusRowFromSnapshot(
  snapshot: CodexStatusSnapshot,
  attachment: CodexAttachmentRow,
  target: CodexPaneIdentity,
): CodexStatusRow {
  return {
    chat_id: attachment.chat_id,
    owner_user_id: attachment.owner_user_id,
    server_pid: target.serverPid,
    pane_id: target.paneId,
    pane_pid: target.panePid,
    telegram_message_id: 0,
    status_kind: snapshot.statusKind,
    tool_calls: snapshot.toolCalls,
    edited_files: snapshot.editedFiles,
    explored_things: snapshot.exploredThings,
    active_shells: snapshot.activeShells,
    queued_messages: snapshot.queuedMessages,
    reply_to_message_id: snapshot.replyToMessageId,
    started_at: snapshot.startedAt,
    updated_at: snapshot.startedAt,
  };
}

function parseActivityCounters(value: string): {
  readonly toolCalls: number;
  readonly editedFiles: number;
  readonly exploredThings: number;
  readonly activeShells: number;
} | null {
  const match =
    /^(\d{1,6})\u001f(\d{1,4})(?:\u001f(\d{1,6}))?(?:\u001f(\d{1,3}))?$/u.exec(
    value,
  );
  if (!match) return null;
  return {
    toolCalls: Number(match[1]),
    editedFiles: Number(match[2]),
    exploredThings: match[4] === undefined ? 0 : Number(match[3] ?? 0),
    activeShells: Number(match[4] ?? match[3] ?? 0),
  };
}

function safeStatusCount(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function isCoalescableTransientStatus(kind: TransientStatusKind): boolean {
  return (
    kind === "state_compacting" ||
    kind === "state_working" ||
    kind === "state_waiting_terminal" ||
    kind === "state_activity"
  );
}

function isDeferrableAfterResponse(kind: TransientStatusKind): boolean {
  return isCoalescableTransientStatus(kind) || kind === "state_goal";
}

export function formatCodexTransientRichHtml(
  snapshot: CodexStatusSnapshot,
  now: number = Date.now(),
  profile: ExperienceProfile = DEFAULT_EXPERIENCE_PROFILE,
  goal: Pick<
    CodexGoalRow,
    | "objective"
    | "status"
    | "token_budget"
    | "tokens_used"
    | "time_used_seconds"
  > | null = null,
  thinking: Pick<
    CodexThinkingSectionRow,
    "summaries_json" | "omitted_count"
  > | null = null,
): string {
  const lines: string[] = [];
  const work: string[] = [];
  if (snapshot.toolCalls > 0) {
    work.push(
      `✨ ran <b>${snapshot.toolCalls}</b> ` +
        `${snapshot.toolCalls === 1 ? "cmd" : "cmds"}`,
    );
  }
  if (snapshot.editedFiles > 0) {
    work.push(
      `📝 edited <b>${snapshot.editedFiles}</b> ` +
        `${snapshot.editedFiles === 1 ? "file" : "files"}`,
    );
  }
  if (work.length > 0) lines.push(work.join(" · "));
  if (snapshot.exploredThings > 0) {
    lines.push(
      `🔎 explored <b>${snapshot.exploredThings}</b> ` +
        `${snapshot.exploredThings === 1 ? "thing" : "things"}`,
    );
  }
  const secondary: string[] = [];
  if (snapshot.activeShells > 0) {
    secondary.push(
      `🖥️ <b>${snapshot.activeShells}</b> active ` +
        `${snapshot.activeShells === 1 ? "shell" : "shells"}`,
    );
  }
  if (snapshot.queuedMessages > 0) {
    secondary.push(
      `📥 <b>${snapshot.queuedMessages}</b> ` +
        `${snapshot.queuedMessages === 1 ? "msg" : "msgs"} queued`,
    );
  }
  if (secondary.length > 0) lines.push(secondary.join(" · "));
  if (snapshot.statusKind === "state_image_viewed") {
    lines.push("🖼️ viewed an image");
  }
  if (snapshot.statusKind === "state_compacting") {
    lines.push("🧶 compacting context…");
  }
  if (snapshot.statusKind === "state_waiting_terminal") {
    lines.push("<i>⏳ waiting on a terminal…</i>");
  }
  const headline = snapshot.statusKind === "state_goal"
    ? `<p><mark>🎯 goal · ${goalStatusLabel(goal?.status)}</mark></p>`
    : snapshot.statusKind === "state_interrupting"
      ? "<p><mark>■ interrupt requested</mark></p>"
      : snapshot.statusKind === "state_interrupted"
        ? "<p><mark>■ task interrupted</mark></p>"
        : `<p><mark>${escapeTelegramHtml(
          assistantIdentity(profile),
        )} is working for ${
          formatCompactDuration(Math.max(0, now - snapshot.startedAt))
        }…</mark></p>`;
  const goalSection = goal
    ? `<blockquote><b>🎯 ${escapeTelegramHtml(goalStatusLabel(goal.status))}</b>` +
      `<br/>${escapeTelegramHtml(truncateVisible(goal.objective, 700))}` +
      `<br/><i>${formatGoalUsage(goal)}</i></blockquote>`
    : "";
  return (
    headline +
    (lines.length > 0 ? `<p>${lines.join("<br/>")}</p>` : "") +
    goalSection +
    (thinking ? formatThinkingSectionRichHtml(thinking) : "")
  );
}

function formatCodexTransientFallback(
  snapshot: CodexStatusSnapshot,
  profile: ExperienceProfile = DEFAULT_EXPERIENCE_PROFILE,
  goal: Pick<
    CodexGoalRow,
    | "objective"
    | "status"
    | "token_budget"
    | "tokens_used"
    | "time_used_seconds"
  > | null = null,
  thinking: Pick<
    CodexThinkingSectionRow,
    "summaries_json" | "omitted_count"
  > | null = null,
): string {
  return formatCodexTransientRichHtml(
    snapshot,
    Date.now(),
    profile,
    goal,
    thinking,
  )
    .replaceAll("<mark>", "<b>")
    .replaceAll("</mark>", "</b>")
    .replaceAll("<p>", "")
    .replaceAll("</p>", "\n")
    .replaceAll("<br/>", "\n")
    .trim();
}

export function formatCodexActivityStatus(
  value: string,
  _assistantName: CodexAssistantName = "Codex",
  profile: ExperienceProfile = DEFAULT_EXPERIENCE_PROFILE,
): string | null {
  const match =
    /^(\d{1,6})\u001f(\d{1,4})(?:\u001f(\d{1,6}))?(?:\u001f(\d{1,3}))?$/u.exec(
    value,
  );
  if (!match) return null;
  const things = Number(match[1]);
  const files = Number(match[2]);
  const explored = match[4] === undefined ? 0 : Number(match[3] ?? 0);
  const shells = Number(match[4] ?? match[3] ?? 0);
  const work: string[] = [];
  if (things > 0) {
    work.push(
      `✨ ran <b>${things}</b> ${things === 1 ? "cmd" : "cmds"}`,
    );
  }
  if (files > 0) {
    work.push(
      `📝 edited <b>${files}</b> ${files === 1 ? "file" : "files"}`,
    );
  }
  return (
    `<b>${escapeTelegramHtml(assistantIdentity(profile))} is working…</b>\n` +
    (work.length > 0 ? `${work.join(" · ")}` : "") +
    (explored > 0
      ? `\n🔎 explored <b>${explored}</b> ` +
        `${explored === 1 ? "thing" : "things"}`
      : "") +
    (shells > 0
      ? `\n🖥️ <b>${shells}</b> active ${shells === 1 ? "shell" : "shells"}`
      : "")
  );
}

export function formatCodexQueuedUntilToolStatus(
  count: number,
  _assistantName: CodexAssistantName = "Codex",
): string {
  const safeCount = Number.isSafeInteger(count) && count > 0 ? count : 1;
  return `📥 <b>${safeCount}</b> ${safeCount === 1 ? "msg" : "msgs"} queued`;
}

export function selectTelegramMedia(
  message: TelegramMessage,
): TelegramInboundMedia | null {
  if (message.document) return documentMedia(message.document);
  const photo = largestTelegramPhoto(message.photo);
  if (!photo) return null;
  return {
    fileId: photo.file_id,
    fileName: "photo.jpg",
    mimeType: "image/jpeg",
    ...(photo.file_size !== undefined && {
      declaredBytes: photo.file_size,
    }),
    kind: "image",
  };
}

export function selectTelegramVoice(
  message: TelegramMessage,
): TelegramInboundVoice | null {
  if (message.voice) {
    return voiceMedia(message.voice);
  }
  if (message.audio) {
    const mimeType = message.audio.mime_type?.trim() || "audio/mpeg";
    return {
      fileId: message.audio.file_id,
      fileName: message.audio.file_name?.trim()
        ? sanitizeAttachmentFileName(message.audio.file_name)
        : audioFileName(mimeType),
      mimeType,
      ...(message.audio.file_size !== undefined && {
        declaredBytes: message.audio.file_size,
      }),
    };
  }
  return null;
}

function voiceMedia(voice: TelegramVoice): TelegramInboundVoice {
  const mimeType = voice.mime_type?.trim() || "audio/ogg";
  return {
    fileId: voice.file_id,
    fileName: audioFileName(mimeType, true),
    mimeType,
    ...(voice.file_size !== undefined && {
      declaredBytes: voice.file_size,
    }),
  };
}

function audioFileName(mimeType: string, voice = false): string {
  const extension = mimeType.toLowerCase().includes("ogg")
    ? "ogg"
    : mimeType.toLowerCase().includes("wav")
      ? "wav"
      : mimeType.toLowerCase().includes("webm")
        ? "webm"
        : "mp3";
  return `${voice ? "voice-note" : "audio"}.${extension}`;
}

function largestTelegramPhoto(
  photos: readonly TelegramPhotoSize[] | undefined,
): TelegramPhotoSize | null {
  if (!photos?.length) return null;
  return photos.reduce((largest, candidate) => {
    const candidateArea = candidate.width * candidate.height;
    const largestArea = largest.width * largest.height;
    if (candidateArea !== largestArea) {
      return candidateArea > largestArea ? candidate : largest;
    }
    return (candidate.file_size ?? 0) > (largest.file_size ?? 0)
      ? candidate
      : largest;
  });
}

function documentMedia(document: TelegramDocument): TelegramInboundMedia {
  const mimeType = document.mime_type?.trim() || "application/octet-stream";
  return {
    fileId: document.file_id,
    fileName: document.file_name?.trim() || "attachment.bin",
    mimeType,
    ...(document.file_size !== undefined && {
      declaredBytes: document.file_size,
    }),
    kind: mimeType.toLowerCase().startsWith("image/") ? "image" : "file",
  };
}

export function sanitizeAttachmentFileName(value: string): string {
  const normalized = value
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .replace(/[\\/]/gu, "_")
    .replace(/[^\p{L}\p{N}._ -]+/gu, "_")
    .replace(/\s+/gu, "_")
    .replace(/\.{2,}/gu, "_")
    .replace(/^\.+/u, "")
    .replace(/_+/gu, "_")
    .slice(0, 120);
  return normalized && !/^[_ .-]+$/u.test(normalized)
    ? normalized
    : "attachment.bin";
}

export function buildCodexAttachmentPrompt(
  attachments: readonly StoredCodexAttachment[],
  caption: string,
): string {
  const lines = [
    "Sent from Telegram with the following attachments.",
    "Please inspect each file with the appropriate tools before replying; use the image viewer for images.",
    "",
    ...attachments.map(
      (attachment, index) =>
        `${index + 1}. ${attachment.path} ` +
        `(${attachment.mimeType}, ${attachment.bytes} bytes, ${attachment.kind})`,
    ),
    "",
    "Message:",
    caption.trim() || "(No message was included.)",
  ];
  return lines.join("\n");
}

function pruneOldAttachmentDirectories(root: string, now: number): void {
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name);
    try {
      if (now - statSync(candidate).mtimeMs > CODEX_ATTACHMENT_RETENTION_MS) {
        rmSync(candidate, { recursive: true, force: true });
      }
    } catch {
      // A concurrent cleanup or unreadable stale entry is harmless.
    }
  }
}

function parseTargetPayload(value: unknown): CodexPaneIdentity | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("target" in value)
  ) {
    return null;
  }
  return isPaneIdentity(value.target) ? value.target : null;
}

function paneIdentityPayload(pane: CodexPane): CodexPaneIdentity {
  return {
    serverPid: pane.serverPid,
    paneId: pane.paneId,
    panePid: pane.panePid,
  };
}

function attachmentTarget(row: CodexAttachmentRow): CodexPaneIdentity {
  return {
    serverPid: row.server_pid,
    paneId: row.pane_id,
    panePid: row.pane_pid,
  };
}

function telegramDeliveryId(
  row: CodexAttachmentRow,
  telegramMessageId: number,
): string {
  return [
    "tg",
    row.chat_id,
    row.owner_user_id,
    row.message_thread_id,
    telegramMessageId,
  ].join(":");
}

interface HandoffDirective {
  readonly destination: CodexPaneIdentity;
  readonly kind: "navigate" | "created";
}

function parseHandoffDirective(
  value: string,
): HandoffDirective | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (isPaneIdentity(parsed)) {
      return { destination: parsed, kind: "navigate" };
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      "destination" in parsed &&
      isPaneIdentity(parsed.destination)
    ) {
      return {
        destination: parsed.destination,
        kind:
          "kind" in parsed && parsed.kind === "created"
            ? "created"
            : "navigate",
      };
    }
    return null;
  } catch {
    return null;
  }
}

function forumTopicUrl(
  chatId: number,
  messageThreadId: number,
): string | null {
  const match = String(chatId).match(/^-100(\d+)$/u);
  return match && messageThreadId > 0
    ? `https://t.me/c/${match[1]}/${messageThreadId}`
    : null;
}

function isLobbyPane(pane: Pick<CodexPane, "windowName" | "assistantName">): boolean {
  return pane.assistantName === "Lobby" ||
    pane.windowName === CHATINABOX_LOBBY_NAME;
}

function displayName(row: CodexAttachmentRow): string {
  return row.window_name || `${row.session_name}:${row.pane_id}`;
}

function resolvePaneArgument(
  panes: readonly CodexPane[],
  argument: string,
): CodexPane | null {
  const normalized = argument.normalize("NFC").trim();
  if (/^\d{1,2}$/u.test(normalized)) {
    return panes[Number(normalized) - 1] ?? null;
  }
  if (/^%\d{1,10}$/u.test(normalized)) {
    return panes.find((pane) => pane.paneId === normalized) ?? null;
  }
  const byName = panes.filter(
    (pane) =>
      pane.windowName.toLowerCase() === normalized.toLowerCase() ||
      pane.sessionName.toLowerCase() === normalized.toLowerCase(),
  );
  return byName.length === 1 ? byName[0] : null;
}

function normalizeName(value: string): string | undefined {
  const normalized = value
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 128);
  return normalized || undefined;
}

function shortPath(value: string): string {
  const home = homedir();
  if (value === home) return "~";
  if (value.startsWith(`${home}${path.sep}`)) {
    return `~/${value.slice(home.length + 1)}`.slice(0, 42);
  }
  return value.slice(0, 42);
}

function truncateVisible(value: string, maxCharacters: number): string {
  const characters = Array.from(value.trim());
  return characters.length <= maxCharacters
    ? characters.join("")
    : `${characters.slice(0, Math.max(1, maxCharacters - 1)).join("")}…`;
}

function sessionButtonLabel(pane: CodexPane, attached: boolean): string {
  if (isLobbyPane(pane)) {
    return `${attached ? "✓ " : ""}${pane.busy ? "⏳" : "🪄"} Lobby`;
  }
  const state = pane.busy ? "⏳" : "●";
  const name = truncateVisible(pane.windowName, 25);
  const cwd = shortPath(pane.cwd);
  return truncateVisible(
    `${attached ? "✓ " : ""}${state} ` +
      `${normalizeAssistantName(pane.assistantName)} · ${name} · ${cwd}`,
    64,
  );
}

function nextFriendlyName(): string {
  return `Session · ${new Date().toISOString().slice(11, 16).replace(":", "")}`;
}

function callbackAnswer(action: string): string {
  const labels: Record<string, string> = {
    "codex.attach": "Connecting…",
    "codex.detach": "Opening Lobby…",
    "codex.new": "Starting Codex…",
    "codex.refresh": "Refreshing…",
    "codex.interrupt": "Interrupting…",
    "codex.transient_interrupt": "Interrupting…",
    "codex.goal_pause": "Goal will pause after this turn…",
    "codex.goal_resume": "Resuming goal…",
    "codex.goal_edit": "Ready for the new objective…",
    "codex.goal_edit_cancel": "Goal edit cancelled",
    "codex.goal_clear": "Confirm goal clearing…",
    "codex.goal_clear_confirm": "Clearing goal…",
    "codex.screen": "Capturing terminal…",
    "codex.key": "Sending key…",
  };
  return labels[action] ?? "Working…";
}

function goalStatusLabel(status: CodexGoalRow["status"] | undefined): string {
  switch (status) {
    case "active":
      return "active";
    case "paused":
      return "paused";
    case "blocked":
      return "blocked";
    case "usageLimited":
      return "usage limited";
    case "budgetLimited":
      return "budget reached";
    case "complete":
      return "complete";
    default:
      return "goal";
  }
}

function formatGoalUsage(
  goal: Pick<
    CodexGoalRow,
    "token_budget" | "tokens_used" | "time_used_seconds"
  >,
): string {
  const tokens = goal.token_budget === null
    ? `${goal.tokens_used.toLocaleString("en-US")} tokens`
    : `${goal.tokens_used.toLocaleString("en-US")} / ` +
      `${goal.token_budget.toLocaleString("en-US")} tokens`;
  return `${tokens} · ${formatCompactDuration(goal.time_used_seconds * 1_000)}`;
}

function formatGoalCompletion(completion: CodexGoalHistoryRow): string {
  const topic = completion.topic_name
    ? ` · ${escapeTelegramHtml(completion.topic_name)}`
    : "";
  return (
    `<p><mark>✓ goal complete${topic}</mark></p>` +
    `<blockquote>${escapeTelegramHtml(
      truncateVisible(completion.objective, 1_200),
    )}<br/><i>${completion.tokens_used.toLocaleString("en-US")} tokens · ${
      formatCompactDuration(completion.time_used_seconds * 1_000)
    }</i></blockquote>`
  );
}

export function formatGoalEditPrompt(goal: CodexGoalRow): string {
  return (
    "<p><mark>✏️ editing goal</mark></p>" +
    "<blockquote>Send the replacement objective as your next message." +
    "<br/><i>Your current goal remains unchanged until that message succeeds." +
    "</i></blockquote>" +
    `<p><b>Current</b><br/>${escapeTelegramHtml(
      truncateVisible(goal.objective, 700),
    )}</p>`
  );
}

export function visibleCodexGoal(
  goal: CodexGoalRow | null,
): CodexGoalRow | null {
  return goal?.status === "complete" ? null : goal;
}

function threadGoalFromRow(goal: CodexGoalRow): CodexThreadGoal {
  return {
    threadId: goal.thread_id,
    objective: goal.objective,
    status: goal.status,
    tokenBudget: goal.token_budget,
    tokensUsed: goal.tokens_used,
    timeUsedSeconds: goal.time_used_seconds,
    createdAt: goal.goal_created_at,
    updatedAt: goal.goal_updated_at,
  };
}

export function codexHelpText(
  profile: ExperienceProfile = DEFAULT_EXPERIENCE_PROFILE,
): string {
  const manager = profile.manager;
  const overview = profile.overview;
  return (
    "🪄 <b>Chatinabox controls</b>\n\n" +
    "<b>Sessions</b>\n" +
    "<code>/codex</code> — list running and recent chats; tap one to attach\n" +
    "<code>/codex new [name]</code> — start a worker; forums open a linked topic\n" +
    "<code>/codex rename name</code> — rename the attached session\n" +
    "<code>/codex detach</code> — open Manager in a forum; return to Lobby in private\n" +
    "<code>/codex off</code> — pause routing; your next message wakes Lobby\n" +
    "<code>/codex interrupt</code> — interrupt the current run with Ctrl-C\n\n" +
    "<b>Forum topics</b>\n" +
    "<code>/forum setup</code> — prepare Overview and Manager from General\n" +
    "<code>/setup</code> — reopen setup for a normal work topic\n" +
    `<code>/overview refresh</code> — refresh the ` +
    `${escapeTelegramHtml(overview.name)} dashboard\n` +
    `<code>/manager wake</code> — reconnect the 🔮 ` +
    `${escapeTelegramHtml(manager.role)} topic\n` +
    "Renaming a connected topic also renames its live Codex session.\n\n" +
    "<b>Experience</b>\n" +
    "<code>/settings</code> — revisit names, symbols, and defaults with the guide\n\n" +
    "<b>Terminal</b>\n" +
    "<code>/screen</code> — fresh terminal view with tap controls\n" +
    "<code>/key KEY [KEY…]</code> — send 1–8 keys, separated by spaces or commas\n" +
    "Keys: <code>esc</code>, <code>enter</code>, <code>up</code>, " +
    "<code>down</code>, <code>left</code>, <code>right</code>, " +
    "<code>tab</code>, <code>backtab</code>, <code>pageup</code>, " +
    "<code>pagedown</code>, <code>home</code>, <code>end</code>, " +
    "<code>backspace</code>, <code>space</code>, <code>ctrl-c</code>, " +
    "<code>ctrl-d</code>, <code>ctrl-l</code>, <code>ctrl-r</code>.\n" +
    "Aliases: <code>escape</code>, <code>return</code>, <code>pgup</code>, " +
    "<code>pgdn</code>.\n" +
    "Examples: <code>/key down down enter</code> · " +
    "<code>/key esc</code> · <code>/key ctrl-c</code>\n" +
    "Mobile shortcut: send only <code>up</code>, <code>down</code>, " +
    "<code>left</code>, or <code>right</code> as a normal message—alone or " +
    "in a sequence such as <code>down down right</code>.\n" +
    "A sent key automatically refreshes the terminal view.\n\n" +
    "<b>Messages and files</b>\n" +
    "While attached, normal messages go to this session. Several quick messages " +
    "are bundled in order. Photos, files, albums, and captions are supported.\n" +
    "Codex slash commands such as <code>/model</code> are forwarded too. If one " +
    "opens a picker, use <code>/screen</code> and the buttons or <code>/key</code>.\n" +
    "Chatinabox commands are handled locally; every other slash command is sent " +
    "straight to the attached Codex terminal.\n\n" +
    "<b>Status guide</b>\n" +
    "✨ commands · 📝 edited files · 🔎 explored items\n" +
    "🖥️ active shells · 📥 queued messages · ⏳ waiting on a terminal\n" +
    "🧶 context compaction · 🖼️ image viewing\n\n" +
    "Aliases such as <code>/codex_new</code> and <code>/codex_screen</code> " +
    "remain available for Telegram command menus."
  );
}

export function formatCodexEvent(
  event: CodexEvent,
  profile: ExperienceProfile = DEFAULT_EXPERIENCE_PROFILE,
  thinking: Pick<
    CodexThinkingSectionRow,
    "summaries_json" | "omitted_count"
  > | null = null,
): string[] {
  if (event.kind === "agent_reasoning") {
    return [
      `<b>${escapeTelegramHtml(agentReasoningText(event.message))}... 🪄</b>`,
    ];
  }
  const bodyChunks = renderTelegramMarkdownChunks(
    event.message,
    TELEGRAM_SAFE_TEXT_CHARS,
  );
  const heading =
    event.kind === "user_local"
      ? "✍🏻 <b>You · VPS</b>\n\n"
      : `<b>${escapeTelegramHtml(assistantIdentity(profile))}</b>\n\n`;
  const footer = event.kind === "assistant_progress"
    ? "\n\n<i>cont.</i>"
    : event.kind === "assistant_final"
      ? "\n\n<i>fin</i>"
      : "";
  return bodyChunks.map(
    (chunk, index) =>
      `${index === 0 && thinking
        ? `${formatThinkingSectionRichHtml(thinking)}\n\n`
        : ""}` +
      `${index === 0 ? heading : ""}${chunk}` +
      `${index === bodyChunks.length - 1 ? footer : ""}`,
  );
}

export function formatAgentReasoningRichMarkdown(message: string): string {
  const text = agentReasoningText(message)
    .replaceAll("==", "＝")
    .replaceAll("*", "✱");
  return `==*${text}... 🪄*==`;
}

export function formatThinkingSectionRichHtml(
  row: Pick<CodexThinkingSectionRow, "summaries_json" | "omitted_count">,
): string {
  const summaries = parseThinkingSummaries(row.summaries_json);
  const omitted = row.omitted_count > 0
    ? `<p><i>${row.omitted_count} earlier ` +
      `${row.omitted_count === 1 ? "thought" : "thoughts"} omitted</i></p>`
    : "";
  const body = summaries.map(
    (summary) =>
      `<p><mark><i>${escapeTelegramHtml(
        agentReasoningText(summary),
      )}</i></mark></p>`,
  ).join("");
  return (
    "<details><summary>show thinking</summary>" +
    omitted +
    body +
    "</details>"
  );
}

function agentReasoningText(message: string): string {
  return message
    .replace(/\u0000/gu, "�")
    .trim()
    .replace(/^\*{2}([\s\S]*?)\*{2}$/u, "$1")
    .replace(/\s+/gu, " ")
    .replace(/[.…]+$/u, "")
    .slice(0, 1_000) || "thinking";
}

function assistantIdentity(profile: ExperienceProfile): string {
  return [profile.assistant.name, profile.assistant.mark]
    .filter((value) => value.length > 0)
    .join(" ");
}

function workerDefaults(profile: ExperienceProfile): {
  readonly model: "sol" | "luna" | "terra";
  readonly reasoningEffort: "low" | "medium" | "high" | "xhigh";
  readonly fast: boolean;
} {
  return {
    model: profile.sessions.defaultModel,
    reasoningEffort: profile.sessions.defaultReasoningEffort,
    fast: profile.sessions.defaultFast,
  };
}

function safeHighlightText(value: string): string {
  return value
    .replaceAll("==", "＝")
    .replaceAll("*", "✱")
    .replace(/\s+/gu, " ")
    .trim();
}

export interface CodexResponseDetails {
  readonly model: string;
  readonly reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  readonly fast: boolean;
  readonly cwd: string;
  readonly turnElapsedMs: number;
  readonly totalWorkMs: number;
  readonly contextUsedPercent?: number;
}

export function formatCodexRichMarkdown(
  event: CodexEvent,
  details?: CodexResponseDetails,
  profile: ExperienceProfile = DEFAULT_EXPERIENCE_PROFILE,
  thinking: Pick<
    CodexThinkingSectionRow,
    "summaries_json" | "omitted_count"
  > | null = null,
): string {
  const heading = event.kind === "user_local"
    ? "✍🏻 **you · vps**"
    : `==${safeHighlightText(assistantIdentity(profile))}==`;
  const body = event.message
    .replace(/\u0000/gu, "�")
    .trim() || "(Codex finished without a text response.)";
  if (event.kind === "user_local") return `${heading}\n\n${body}`;
  const detailsBlock =
    event.kind === "assistant_final" && details
      ? `\n\n${formatCodexResponseDetails(details)}`
      : "";
  const footer = event.kind === "assistant_progress" ? "cont." : "fin";
  const thinkingBlock = thinking
    ? `${formatThinkingSectionRichHtml(thinking)}\n\n`
    : "";
  return (
    `${thinkingBlock}${heading}\n\n${body}${detailsBlock}` +
    `\n\n<footer>${footer}</footer>`
  );
}

function formatCodexResponseDetails(details: CodexResponseDetails): string {
  const profile = [
    details.model,
    details.reasoningEffort,
    details.fast ? "fast" : null,
  ].filter((value): value is string => Boolean(value)).join(" · ");
  const cwd = details.cwd
    .replaceAll("`", "′")
    .replace(/\s+/gu, " ")
    .slice(0, 4_096);
  const timing = [
    `turn ${formatCompactDuration(details.turnElapsedMs)}`,
    `total ${formatCompactDuration(details.totalWorkMs)}`,
    details.contextUsedPercent === undefined
      ? null
      : `context rem. ${Math.max(0, 100 - details.contextUsedPercent)}%`,
  ].filter((value): value is string => value !== null).join(" · ");
  return (
    "<details><summary>details</summary>\n\n" +
    `\`${profile}\`\n\n` +
    `\`⌂ ${cwd}\`\n\n` +
    `\`${timing}\`\n\n` +
    "</details>"
  );
}

function responseModelLabel(event: CodexEvent): string {
  const model = event.model?.toLowerCase() ?? "";
  if (model.includes("luna")) return "luna";
  if (model.includes("terra")) return "terra";
  if (model.includes("sol")) return "sol";
  const assistant = event.assistantName.toLowerCase();
  return assistant === "codex" || assistant === "lobby"
    ? "sol"
    : assistant;
}

function formatCompactDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds > 0 ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

function statusSnapshotFromRow(
  row: CodexStatusRow,
  replyToMessageId: number | null,
): CodexStatusSnapshot {
  return {
    statusKind: row.status_kind,
    toolCalls: row.tool_calls,
    editedFiles: row.edited_files,
    exploredThings: row.explored_things,
    activeShells: row.active_shells,
    queuedMessages: row.queued_messages,
    replyToMessageId,
    startedAt: row.started_at,
  };
}

function formatPromotedContextCompaction(
  profile: ExperienceProfile = DEFAULT_EXPERIENCE_PROFILE,
  thinking: Pick<
    CodexThinkingSectionRow,
    "summaries_json" | "omitted_count"
  > | null = null,
): string {
  return (
    (thinking ? formatThinkingSectionRichHtml(thinking) : "") +
    `<p><mark>${escapeTelegramHtml(assistantIdentity(profile))}</mark></p>` +
    "<p>🧶 context compacted</p>" +
    "<footer>cont.</footer>"
  );
}

function telegramEditSucceeded(
  result:
    | { readonly ok: boolean; readonly description?: string }
    | null
    | undefined,
): boolean {
  return result?.ok === true ||
    /not modified/iu.test(result?.description ?? "");
}

function parseResumePayload(
  value: unknown,
): { readonly id: string; readonly name: string } | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("id" in value) ||
    !("name" in value)
  ) {
    return null;
  }
  const id = value.id;
  const name = value.name;
  return typeof id === "string" &&
      /^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(id) &&
      typeof name === "string" &&
      name.length > 0 &&
      name.length <= 80
    ? { id, name }
    : null;
}

const TELEGRAM_KEY_ALIASES: Readonly<Record<string, string>> = {
  esc: "esc",
  escape: "esc",
  enter: "enter",
  return: "enter",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  tab: "tab",
  backtab: "backtab",
  pageup: "pageup",
  pgup: "pageup",
  pagedown: "pagedown",
  pgdn: "pagedown",
  home: "home",
  end: "end",
  backspace: "backspace",
  space: "space",
  "ctrl-c": "ctrl-c",
  "ctrl-d": "ctrl-d",
  "ctrl-l": "ctrl-l",
  "ctrl-r": "ctrl-r",
};

function parseKeyCommand(value: string): string[] | null {
  const raw = value
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .split(/[\s,]+/u)
    .filter(Boolean);
  if (raw.length < 1 || raw.length > 8) return null;
  const keys = raw.map((key) => TELEGRAM_KEY_ALIASES[key]);
  return keys.every((key): key is string => key !== undefined) ? keys : null;
}

export function parseArrowShortcut(value: string): string[] | null {
  const keys = parseKeyCommand(value);
  return keys && keys.every((key) =>
    key === "up" || key === "down" || key === "left" || key === "right"
  )
    ? keys
    : null;
}

function parseKeyPayload(value: unknown): string | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("key" in value) ||
    typeof value.key !== "string"
  ) {
    return null;
  }
  return TELEGRAM_KEY_ALIASES[value.key] ?? null;
}

function splitText(value: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let remaining = value;
  while (remaining.length > maxChars) {
    const candidate = remaining.slice(0, maxChars);
    const newline = candidate.lastIndexOf("\n");
    const splitAt = newline >= Math.floor(maxChars * 0.55) ? newline + 1 : maxChars;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  chunks.push(remaining);
  return chunks;
}

function isTelegramIdentity(
  value: unknown,
  positiveOnly: boolean,
): value is number {
  return (
    Number.isSafeInteger(value) &&
    Number(value) !== 0 &&
    (!positiveOnly || Number(value) > 0)
  );
}
