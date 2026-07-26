import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
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
  tgDeleteMessage,
  tgDownloadFile,
  tgEditPhotoMedia,
  tgEditMessage,
  tgEditMessageCaption,
  tgGetFile,
  tgSend,
  tgSendPhoto,
  tgSendRichMarkdown,
} from "../telegram";
import type {
  TelegramCallbackQuery,
  TelegramDocument,
  TelegramMessage,
  TelegramPhotoSize,
} from "../telegram-types";
import { abortableSleep } from "./sleep";
import { CodexBridgeClient } from "./codex-bridge-client";
import {
  CATINABOX_LOBBY_NAME,
  isPaneIdentity,
  normalizeAssistantName,
  samePaneIdentity,
  type CodexAssistantName,
  type CodexBridgeResponse,
  type CodexPane,
  type CodexPaneIdentity,
  type CodexRecentSession,
  type CodexEvent,
} from "./codex-bridge-protocol";
import type { CatinaboxEnv } from "./env";
import type {
  CodexAttachmentRow,
  CatinaboxStore,
} from "./store";
import {
  hasMarkdownTable,
  renderTelegramMarkdownChunks,
} from "./telegram-markdown";

const CODEX_CALLBACK_TTL_MS = 24 * 60 * 60 * 1_000;
const TELEGRAM_SAFE_TEXT_CHARS = 3_400;
const CODEX_ATTACHMENT_MAX_COUNT = 10;
const CODEX_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
const CODEX_ATTACHMENT_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const CODEX_ATTACHMENT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS = 900;
const TELEGRAM_TEXT_BURST_DEBOUNCE_MS = 700;

interface CodexTelegramDependencies {
  readonly env: CatinaboxEnv;
  readonly store: CatinaboxStore;
  readonly bridge?: CodexBridgeClient;
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

export class CodexTelegramController {
  private readonly bridge: CodexBridgeClient;
  private readonly mediaGroups = new Map<string, PendingMediaGroup>();
  private readonly textBurstTimers = new Map<string, NodeJS.Timeout>();
  private readonly flushingTextBursts = new Set<string>();

  constructor(private readonly dependencies: CodexTelegramDependencies) {
    this.bridge =
      dependencies.bridge ??
      new CodexBridgeClient(dependencies.env.CODEX_BRIDGE_SOCKET);
  }

  isAttached(chatId: number, ownerUserId: number): boolean {
    return this.dependencies.store.codexAttachment(
      chatId,
      ownerUserId,
    ) !== null;
  }

  /** Attach the owner's chat to the persistent lobby when no session is active. */
  async ensureLobbyAttached(
    chatId: number,
    ownerUserId: number,
  ): Promise<boolean> {
    if (this.isAttached(chatId, ownerUserId)) return true;
    return (await this.attachLobby(chatId, ownerUserId)) !== null;
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
            );
            return true;
          }
          if (subcommand?.toLowerCase() === "rename") {
            await this.rename(
              chatId,
              ownerUserId!,
              subargument,
              message.message_id,
            );
            return true;
          }
          if (subcommand?.toLowerCase() === "detach") {
            await this.detach(chatId, ownerUserId!, message.message_id);
            return true;
          }
          if (subcommand?.toLowerCase() === "off") {
            await this.turnOff(chatId, ownerUserId!, message.message_id);
            return true;
          }
          if (subcommand?.toLowerCase() === "interrupt") {
            await this.interrupt(chatId, ownerUserId!, message.message_id);
            return true;
          }
          if (subcommand?.toLowerCase() === "screen") {
            await this.sendScreen(chatId, ownerUserId!, message.message_id);
            return true;
          }
          if (subcommand?.toLowerCase() === "key") {
            await this.sendKeyCommand(
              chatId,
              ownerUserId!,
              subargument,
              message.message_id,
            );
            return true;
          }
          if (subcommand?.toLowerCase() === "help") {
            await tgSend(
              this.dependencies.env,
              chatId,
              codexHelpText(),
              message.message_id,
            );
            return true;
          }
        }
        await this.sendMenu(chatId, ownerUserId!, message.message_id);
        return true;
      case "attach":
      case "codex_attach":
        await this.attachByArgument(
          chatId,
          ownerUserId!,
          command.argument,
          message.message_id,
        );
        return true;
      case "detach":
      case "unattach":
      case "codex_detach":
        await this.detach(chatId, ownerUserId!, message.message_id);
        return true;
      case "codex_new":
        await this.createAndAttach(
          chatId,
          ownerUserId!,
          normalizeName(command.argument),
          message.message_id,
        );
        return true;
      case "codex_rename":
        await this.rename(
          chatId,
          ownerUserId!,
          command.argument,
          message.message_id,
        );
        return true;
      case "codex_interrupt":
        await this.interrupt(chatId, ownerUserId!, message.message_id);
        return true;
      case "screen":
      case "codex_screen":
        await this.sendScreen(chatId, ownerUserId!, message.message_id);
        return true;
      case "key":
      case "codex_key":
        await this.sendKeyCommand(
          chatId,
          ownerUserId!,
          command.argument,
          message.message_id,
        );
        return true;
      case "codex_help":
        await tgSend(
          this.dependencies.env,
          chatId,
          codexHelpText(),
          message.message_id,
        );
        return true;
      default:
        return false;
    }
  }

  async handleCallback(callback: TelegramCallbackQuery): Promise<boolean> {
    const chatId = callback.message?.chat.id;
    const messageId = callback.message?.message_id;
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
    if (!parsed.ok || !parsed.value.action.startsWith("codex.")) return false;

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
        this.dependencies.store.attachCodex(chatId!, ownerUserId, pane);
        await this.editMenu(chatId!, ownerUserId, messageId!);
        return true;
      }
      case "codex.detach":
        await this.attachLobby(chatId!, ownerUserId);
        await this.editMenu(chatId!, ownerUserId, messageId!);
        return true;
      case "codex.refresh":
        await this.editMenu(chatId!, ownerUserId, messageId!);
        return true;
      case "codex.new": {
        const result = await this.bridge.request({
          op: "new",
          name: nextFriendlyName(),
          cwd: this.dependencies.env.DEFAULT_CWD,
        }).catch(() => null);
        if (!result?.ok || !("pane" in result)) {
          await this.editError(
            chatId!,
            messageId!,
            result && !result.ok
              ? result.error
              : "The Codex bridge is unavailable.",
          );
          return true;
        }
        this.dependencies.store.attachCodex(chatId!, ownerUserId, result.pane);
        await this.editMenu(chatId!, ownerUserId, messageId!);
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
        }).catch(() => null);
        if (!result?.ok || !("pane" in result)) {
          await this.editError(
            chatId!,
            messageId!,
            result && !result.ok
              ? result.error
              : "The Codex bridge is unavailable.",
          );
          return true;
        }
        this.dependencies.store.attachCodex(chatId!, ownerUserId, result.pane);
        await this.editMenu(chatId!, ownerUserId, messageId!);
        return true;
      }
      case "codex.interrupt": {
        const attachment = this.dependencies.store.codexAttachment(
          chatId!,
          ownerUserId,
        );
        if (!attachment) {
          await this.editMenu(chatId!, ownerUserId, messageId!);
          return true;
        }
        await this.bridge.request({
          op: "interrupt",
          target: attachmentTarget(attachment),
        }).catch(() => null);
        await this.editMenu(chatId!, ownerUserId, messageId!);
        return true;
      }
      case "codex.screen":
        await this.sendScreen(
          chatId!,
          ownerUserId,
          undefined,
          {
            messageId: messageId!,
            isPhoto: Boolean(callback.message?.photo?.length),
          },
        );
        return true;
      case "codex.key": {
        const key = parseKeyPayload(parsed.value.payload);
        if (!key) return true;
        await this.sendKeys(chatId!, ownerUserId, [key], messageId!);
        await this.sendScreen(
          chatId!,
          ownerUserId,
          undefined,
          {
            messageId: messageId!,
            isPhoto: Boolean(callback.message?.photo?.length),
          },
          250,
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
    );
    if (!attachment) return false;
    const target = attachmentTarget(attachment);
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
      message.text,
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
    );
    if (!attachment) return false;
    const target = attachmentTarget(attachment);

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

  private async relayPrompt(
    attachment: CodexAttachmentRow,
    target: CodexPaneIdentity,
    text: string,
    replyToMessageId: number,
    reportFailure = true,
    sourceMessageCount = 1,
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
    }).catch(() => null);
    if (!response?.ok) {
      const transient = this.dependencies.store.clearCodexStatus(
        attachment.chat_id,
        attachment.owner_user_id,
        target,
      );
      if (transient) {
        await tgDeleteMessage(
          this.dependencies.env,
          attachment.chat_id,
          transient.telegram_message_id,
        ).catch(() => undefined);
      }
      if (response?.code === "STALE_TARGET") {
        await this.attachLobby(
          attachment.chat_id,
          attachment.owner_user_id,
        );
      }
      if (reportFailure) {
        await tgSend(
          this.dependencies.env,
          attachment.chat_id,
          response && !response.ok
            ? `⚠️ ${escapeTelegramHtml(response.error)}\n` +
              "🪄 You’re back in Lobby; resend your message there."
            : "⚠️ The Codex bridge is unavailable. Your message was not sent.",
          replyToMessageId,
        );
      }
      return false;
    }
    this.dependencies.store.recordCodexPrompt(
      attachment.chat_id,
      attachment.owner_user_id,
      target,
      replyToMessageId,
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
    }
    return true;
  }

  private scheduleTextBurst(key: string, delayMs = TELEGRAM_TEXT_BURST_DEBOUNCE_MS): void {
    const existing = this.textBurstTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.textBurstTimers.delete(key);
      void this.flushTextBurst(key).catch(() => {
        console.error("[CodexTelegram] Text burst relay failed.");
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
      const attachment = this.dependencies.store.codexAttachment(
        parsed.chatId,
        parsed.ownerUserId,
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
        queued[0].telegram_message_id,
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
        console.error("[CodexTelegram] Media album relay failed.");
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
    const transient = this.dependencies.store.clearCodexStatus(
      attachment.chat_id,
      attachment.owner_user_id,
      target,
    );
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
  }

  async run(signal: AbortSignal): Promise<void> {
    await this.bridge.request({ op: "lobby" }).catch(() => {
      console.error("[CodexTelegram] Lobby could not be started.");
    });
    while (!signal.aborted) {
      try {
        await this.deliverEventsOnce();
        await this.flushReadyTextBursts();
      } catch {
        if (!signal.aborted) {
          console.error("[CodexTelegram] Event delivery pass failed; retrying.");
        }
      }
      await abortableSleep(1_000, signal).catch(() => undefined);
    }
  }

  async deliverEventsOnce(): Promise<void> {
    const response = await this.bridge
      .request({ op: "events", limit: 10 })
      .catch(() => null);
    if (!response?.ok || !("events" in response)) return;
    for (const event of response.events) {
      const delivered = await this.deliverEvent(event);
      if (!delivered) return;
      await this.bridge.request({ op: "ack", eventId: event.id });
    }
  }

  private async deliverEvent(event: CodexEvent): Promise<boolean> {
    const attachments =
      this.dependencies.store.codexAttachmentsForTarget(event.target);
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
        );
        if (!sent.ok) return false;
      }
      return true;
    }
    if (event.kind === "session_handoff") {
      const destination = parseHandoffDestination(event.message);
      const panes = destination
        ? await this.listPanes().catch(() => [])
        : [];
      const pane = destination
        ? panes.find((candidate) => samePaneIdentity(candidate, destination))
        : undefined;
      for (const attachment of attachments) {
        if (!pane) {
          const failed = await tgSend(
            this.dependencies.env,
            attachment.chat_id,
            "⚠️ <b>Handoff could not complete.</b>\n" +
              "The destination session is no longer running; you remain here.",
          );
          if (!failed.ok) return false;
          continue;
        }
        this.dependencies.store.attachCodex(
          attachment.chat_id,
          attachment.owner_user_id,
          pane,
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
        const transient = this.dependencies.store.clearCodexStatus(
          attachment.chat_id,
          attachment.owner_user_id,
          event.target,
        );
        let delivered = false;
        if (transient) {
          const edited = await tgEditMessage(
            this.dependencies.env,
            attachment.chat_id,
            transient.telegram_message_id,
            "🧶 <b>Context compacted</b>",
          ).catch(() => null);
          delivered = edited?.ok === true;
        }
        if (!delivered) {
          const sent = await tgSend(
            this.dependencies.env,
            attachment.chat_id,
            "🧶 <b>Context compacted</b>",
          );
          if (!sent.ok) return false;
        }
        continue;
      }
      if (event.kind === "image_viewed") {
        await this.clearQueuedFollowupStatus(attachment, event.target);
        const sent = await tgSend(
          this.dependencies.env,
          attachment.chat_id,
          "🖼️ <b>Viewed image</b>",
        );
        if (!sent.ok) return false;
        continue;
      }
      const transient = this.dependencies.store.clearCodexStatus(
        attachment.chat_id,
        attachment.owner_user_id,
        event.target,
      );
      if (transient) {
        await tgDeleteMessage(
          this.dependencies.env,
          attachment.chat_id,
          transient.telegram_message_id,
        ).catch(() => undefined);
      }
      const pendingBatch = event.kind === "assistant_final"
        ? this.dependencies.store.pendingCodexPromptsThrough(
            attachment.chat_id,
            attachment.owner_user_id,
            event.target,
            event.createdAt,
          )
        : [];
      const pending = pendingBatch[pendingBatch.length - 1];
      let deliveredAsRichMessage = false;
      if (
        hasMarkdownTable(event.message) &&
        event.message.length <= 30_000
      ) {
        const richResult = await tgSendRichMarkdown(
          this.dependencies.env,
          attachment.chat_id,
          formatCodexRichMarkdown(event),
          pending?.telegram_message_id,
        ).catch(() => null);
        deliveredAsRichMessage = richResult?.ok === true;
      }
      if (!deliveredAsRichMessage) {
        const chunks = formatCodexEvent(event);
        for (let index = 0; index < chunks.length; index += 1) {
          const result = await tgSend(
            this.dependencies.env,
            attachment.chat_id,
            chunks[index],
            index === 0 ? pending?.telegram_message_id : undefined,
          );
          if (!result.ok) return false;
        }
      }
      if (event.kind === "assistant_final") {
        this.dependencies.store.recordCodexFinalDelivery(
          attachment.chat_id,
          attachment.owner_user_id,
          event.target,
          finalHash!,
        );
      }
      if (pendingBatch.length > 0) {
        this.dependencies.store.markCodexPromptsDelivered(
          pendingBatch.map((row) => row.id),
        );
      }
    }
    return true;
  }

  private async setTransientStatus(
    attachment: CodexAttachmentRow,
    target: CodexPaneIdentity,
    kind:
      | "state_compacting"
      | "state_working"
      | "state_waiting_terminal"
      | "state_queued"
      | "state_activity",
    replyToMessageId?: number,
    queuedCount?: number,
    activityMessage?: string,
    preserveExisting = false,
    assistantNameOverride?: CodexAssistantName,
  ): Promise<void> {
    const assistantName = normalizeAssistantName(
      assistantNameOverride ?? attachment.assistant_name,
    );
    const activityText =
      kind === "state_activity"
        ? formatCodexActivityStatus(activityMessage ?? "", assistantName)
        : null;
    const text =
      kind === "state_compacting"
        ? "🧶 <b>Compacting context…</b>"
        : kind === "state_waiting_terminal"
        ? "⏳ <b>Waiting for terminal…</b>"
        : kind === "state_queued"
          ? `📥 <b>${queuedCount ?? 2} messages bundled for ${assistantName}…</b>`
          : activityText ??
            (
              assistantName === "Lobby"
                ? "🪄 <b>Lobby is thinking…</b>"
                : `🎱 <b>${assistantName} is working…</b>`
            );
    const existing = this.dependencies.store.codexStatus(
      attachment.chat_id,
      attachment.owner_user_id,
      target,
    );
    if (existing) {
      if (preserveExisting) return;
      await tgEditMessage(
        this.dependencies.env,
        attachment.chat_id,
        existing.telegram_message_id,
        text,
      ).catch(() => undefined);
      return;
    }
    const sent = await tgSend(
      this.dependencies.env,
      attachment.chat_id,
      text,
      replyToMessageId,
    ).catch(() => null);
    if (sent?.ok) {
      this.dependencies.store.setCodexStatus(
        attachment.chat_id,
        attachment.owner_user_id,
        target,
        sent.result.message_id,
      );
    }
  }

  private async setQueuedFollowupStatus(
    attachment: CodexAttachmentRow,
    target: CodexPaneIdentity,
    replyToMessageId: number,
    addedCount: number,
  ): Promise<void> {
    const existing = this.dependencies.store.codexQueueStatus(
      attachment.chat_id,
      attachment.owner_user_id,
      target,
    );
    const totalCount = (existing?.message_count ?? 0) + Math.max(1, addedCount);
    const text = formatCodexQueuedUntilToolStatus(
      totalCount,
      normalizeAssistantName(attachment.assistant_name),
    );
    if (existing) {
      await tgEditMessage(
        this.dependencies.env,
        attachment.chat_id,
        existing.telegram_message_id,
        text,
      ).catch(() => undefined);
      this.dependencies.store.setCodexQueueStatus(
        attachment.chat_id,
        attachment.owner_user_id,
        target,
        existing.telegram_message_id,
        totalCount,
      );
      return;
    }
    const sent = await tgSend(
      this.dependencies.env,
      attachment.chat_id,
      text,
      replyToMessageId,
    ).catch(() => null);
    if (sent?.ok) {
      this.dependencies.store.setCodexQueueStatus(
        attachment.chat_id,
        attachment.owner_user_id,
        target,
        sent.result.message_id,
        totalCount,
      );
    }
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
    if (queued) {
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
  ): Promise<void> {
    try {
      const menu = await this.buildMenu(chatId, ownerUserId);
      await tgSend(
        this.dependencies.env,
        chatId,
        menu.text,
        replyToMessageId,
        menu.keyboard,
      );
    } catch {
      await tgSend(
        this.dependencies.env,
        chatId,
        "⚠️ The Codex bridge is unavailable. Try <code>/codex</code> again shortly.",
        replyToMessageId,
      );
    }
  }

  private async editMenu(
    chatId: number,
    ownerUserId: number,
    messageId: number,
  ): Promise<void> {
    try {
      const menu = await this.buildMenu(chatId, ownerUserId);
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
        "The Codex bridge is unavailable. Try again shortly.",
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
  ): Promise<Menu> {
    const { panes, recent } = await this.listSessions();
    const attachment = this.dependencies.store.codexAttachment(
      chatId,
      ownerUserId,
    );
    let activePane = attachment
      ? panes.find((pane) =>
          samePaneIdentity(pane, attachmentTarget(attachment)),
        )
      : undefined;
    if (attachment && !activePane) {
      activePane = await this.attachLobby(chatId, ownerUserId) ?? undefined;
    }

    const rows: InlineKeyboardButtonInput[][] = [];
    const orderedPanes = [...panes].sort(
      (left, right) =>
        Number(isLobbyPane(right)) - Number(isLobbyPane(left)),
    );
    for (const pane of orderedPanes.slice(0, 12)) {
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
          label:
            isLobbyPane(pane)
              ? `${attached ? "✓ " : ""}${pane.busy ? "⏳" : "🪄"} Lobby`
              : `${attached ? "✓ " : ""}${pane.busy ? "⏳" : "●"} ` +
                `${normalizeAssistantName(pane.assistantName)} · ` +
                `${pane.windowName} · ${shortPath(pane.cwd)}`,
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
          label: `↩ ${session.name}`,
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
      { label: "＋ New Codex", callbackData: newAction },
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

    const lines = ["🪩 <b>Codex sessions</b>", ""];
    if (activePane && isLobbyPane(activePane)) {
      lines.push(
        "You’re talking to <b>🪄 Lobby</b> — Catinabox’s persistent control layer.",
        "",
        "Ask it to find, resume, rename, or start a Codex worker. " +
          "New workers default to <b>Sol · high</b> unless you specify otherwise.",
        "Bot controls stay local; other slash commands go to this session.",
      );
    } else if (activePane) {
      lines.push(
        `Connected to <b>${normalizeAssistantName(activePane.assistantName)}</b> ` +
          `in <b>${escapeTelegramHtml(activePane.windowName)}</b>`,
        `<code>${escapeTelegramHtml(activePane.cwd)}</code>`,
        "",
        "Send any normal message to talk directly to this session.",
        "Bot controls stay local; other slash commands go to this session.",
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
    lines.push(
      "",
      "<code>/codex new name</code> · <code>/codex rename name</code>",
      "<code>/codex detach</code> → Lobby · <code>/codex off</code> → routing off",
      "<code>/codex_help</code> for all controls",
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
  ): Promise<void> {
    const panes = await this.listPanes().catch(() => []);
    const pane = resolvePaneArgument(panes, argument);
    if (!pane) {
      await this.sendMenu(chatId, ownerUserId, replyToMessageId);
      return;
    }
    this.dependencies.store.attachCodex(chatId, ownerUserId, pane);
    const assistantName = normalizeAssistantName(pane.assistantName);
    await tgSend(
      this.dependencies.env,
      chatId,
      `✅ Connected to <b>${assistantName}</b> in ` +
        `<b>${escapeTelegramHtml(pane.windowName)}</b>.\n` +
        `Send a normal message to talk to ${assistantName}. ` +
        `Use <code>/detach</code> when finished.`,
      replyToMessageId,
    );
  }

  private async detach(
    chatId: number,
    ownerUserId: number,
    replyToMessageId: number,
  ): Promise<void> {
    const lobby = await this.attachLobby(chatId, ownerUserId);
    await tgSend(
      this.dependencies.env,
      chatId,
      lobby
        ? "🪄 <b>Lobby</b>\nYou’re back at the control layer. Ask me to find, " +
          "resume, rename, or start a Codex session."
        : "⚠️ Lobby could not start. Open <code>/codex</code> to reconnect.",
      replyToMessageId,
    );
  }

  private async attachLobby(
    chatId: number,
    ownerUserId: number,
  ): Promise<CodexPane | null> {
    const response = await this.bridge.request({ op: "lobby" }).catch(() => null);
    if (!response?.ok || !("pane" in response)) return null;
    this.dependencies.store.attachCodex(chatId, ownerUserId, response.pane);
    return response.pane;
  }

  private async turnOff(
    chatId: number,
    ownerUserId: number,
    replyToMessageId: number,
  ): Promise<void> {
    const detached = this.dependencies.store.detachCodex(chatId, ownerUserId);
    await tgSend(
      this.dependencies.env,
      chatId,
      detached
        ? "○ Catinabox routing is off. Your next message will wake the Lobby."
        : "Catinabox routing is already off.",
      replyToMessageId,
    );
  }

  private async createAndAttach(
    chatId: number,
    ownerUserId: number,
    name: string | undefined,
    replyToMessageId: number,
  ): Promise<void> {
    const result = await this.bridge.request({
      op: "new",
      ...(name ? { name } : {}),
      cwd: this.dependencies.env.DEFAULT_CWD,
    }).catch(() => null);
    if (!result?.ok || !("pane" in result)) {
      await tgSend(
        this.dependencies.env,
        chatId,
        result && !result.ok
          ? `⚠️ ${escapeTelegramHtml(result.error)}`
          : "⚠️ The Codex bridge is unavailable.",
        replyToMessageId,
      );
      return;
    }
    this.dependencies.store.attachCodex(chatId, ownerUserId, result.pane);
    const assistantName = normalizeAssistantName(result.pane.assistantName);
    await tgSend(
      this.dependencies.env,
      chatId,
      `✅ Started and connected to <b>${assistantName}</b> in ` +
        `<b>${escapeTelegramHtml(result.pane.windowName)}</b>.\n` +
        "Send your first message whenever you're ready.",
      replyToMessageId,
    );
  }

  private async rename(
    chatId: number,
    ownerUserId: number,
    rawName: string,
    replyToMessageId: number,
  ): Promise<void> {
    const attachment = this.dependencies.store.codexAttachment(
      chatId,
      ownerUserId,
    );
    const name = normalizeName(rawName);
    if (!attachment || !name) {
      await tgSend(
        this.dependencies.env,
        chatId,
        attachment
          ? "Use <code>/codex_rename descriptive name</code>."
          : "Attach a session with <code>/codex</code> first.",
        replyToMessageId,
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
          : "⚠️ The Codex bridge is unavailable.",
        replyToMessageId,
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
    );
  }

  private async interrupt(
    chatId: number,
    ownerUserId: number,
    replyToMessageId: number,
  ): Promise<void> {
    const attachment = this.dependencies.store.codexAttachment(
      chatId,
      ownerUserId,
    );
    if (!attachment) {
      await tgSend(
        this.dependencies.env,
        chatId,
        "Attach a session with <code>/codex</code> first.",
        replyToMessageId,
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
    );
  }

  private async sendScreen(
    chatId: number,
    ownerUserId: number,
    replyToMessageId?: number,
    replacement?: ScreenReplacement,
    captureDelayMs = 0,
  ): Promise<void> {
    const attachment = this.dependencies.store.codexAttachment(
      chatId,
      ownerUserId,
    );
    if (!attachment) {
      await tgSend(
        this.dependencies.env,
        chatId,
        "Attach a session with <code>/codex</code> first.",
        replyToMessageId,
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
      `Updated ${updatedAt} UTC · tall clarity view`;
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
        );
    if (!sent.ok && replacement) {
      sent = await tgSendPhoto(
        this.dependencies.env,
        chatId,
        image,
        caption,
        keyboard,
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
  ): Promise<void> {
    const keys = parseKeyCommand(argument);
    if (!keys) {
      await tgSend(
        this.dependencies.env,
        chatId,
        "Unknown key. Use <code>/codex_help</code> for the complete key list " +
          "and multi-key examples.",
        replyToMessageId,
      );
      return;
    }
    const sent = await this.sendKeys(
      chatId,
      ownerUserId,
      keys,
      replyToMessageId,
    );
    if (sent) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await this.sendScreen(chatId, ownerUserId);
    }
  }

  private async sendKeys(
    chatId: number,
    ownerUserId: number,
    keys: readonly string[],
    replyToMessageId?: number,
  ): Promise<boolean> {
    const attachment = this.dependencies.store.codexAttachment(
      chatId,
      ownerUserId,
    );
    if (!attachment) {
      await tgSend(
        this.dependencies.env,
        chatId,
        "Attach a session with <code>/codex</code> first.",
        replyToMessageId,
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

export function formatCodexActivityStatus(
  value: string,
  assistantName: CodexAssistantName = "Codex",
): string | null {
  const match = /^(\d{1,6})\u001f(\d{1,4})$/u.exec(value);
  if (!match) return null;
  const things = Number(match[1]);
  const files = Number(match[2]);
  const workingIcon = assistantName === "Lobby" ? "🪄" : "🎱";
  return (
    `${workingIcon} <b>${assistantName} is working…</b>\n` +
    `⚙️ Ran <b>${things}</b> ${things === 1 ? "thing" : "things"} · ` +
    `✏️ Edited <b>${files}</b> ${files === 1 ? "file" : "files"}`
  );
}

export function formatCodexQueuedUntilToolStatus(
  count: number,
  assistantName: CodexAssistantName = "Codex",
): string {
  const safeCount = Number.isSafeInteger(count) && count > 0 ? count : 1;
  const subject = safeCount === 1
    ? "Message is"
    : `${safeCount} messages are`;
  return `🟠 <b>${subject} queued · sending after ${assistantName}’s next tool call…</b>`;
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

function parseHandoffDestination(
  value: string,
): CodexPaneIdentity | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isPaneIdentity(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isLobbyPane(pane: Pick<CodexPane, "windowName" | "assistantName">): boolean {
  return pane.assistantName === "Lobby" ||
    pane.windowName === CATINABOX_LOBBY_NAME;
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
    .slice(0, 60);
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

function nextFriendlyName(): string {
  return `codex-${new Date().toISOString().slice(11, 16).replace(":", "")}`;
}

function callbackAnswer(action: string): string {
  const labels: Record<string, string> = {
    "codex.attach": "Connecting…",
    "codex.detach": "Detached",
    "codex.new": "Starting Codex…",
    "codex.refresh": "Refreshing…",
    "codex.interrupt": "Interrupting…",
    "codex.screen": "Capturing terminal…",
    "codex.key": "Sending key…",
  };
  return labels[action] ?? "Working…";
}

export function codexHelpText(): string {
  return (
    "🪩 <b>Codex · complete control guide</b>\n\n" +
    "<b>Sessions</b>\n" +
    "<code>/codex</code> — list running and recent chats; tap one to attach\n" +
    "<code>/codex new [name]</code> — start and attach a Sol · high worker\n" +
    "<code>/codex rename name</code> — rename the attached session\n" +
    "<code>/codex detach</code> — return to the persistent 🪄 Lobby\n" +
    "<code>/codex off</code> — stop routing this Telegram chat to Codex\n" +
    "<code>/codex interrupt</code> — interrupt the current run with Ctrl-C\n\n" +
    "<b>Terminal screen</b>\n" +
    "<code>/screen</code> — post a fresh, tall terminal view with tap controls\n" +
    "Buttons send Esc, arrows, Enter, Tab, PgUp/PgDn, then refresh the screen.\n\n" +
    "<b>Send terminal keys</b>\n" +
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
    "A successful key command automatically refreshes the terminal view.\n\n" +
    "<b>Talking and attachments</b>\n" +
    "While attached, normal messages go to this session. Several quick messages " +
    "are bundled in order. Photos, files, albums, and captions are supported.\n" +
    "Codex slash commands such as <code>/model</code> are forwarded too. If one " +
    "opens a picker, use <code>/screen</code> and the buttons or <code>/key</code>.\n" +
    "Catinabox commands are handled locally; every other slash command is sent " +
    "straight to the attached Codex terminal.\n\n" +
    "<b>Status guide</b>\n" +
    "🎱 working · ⚙️ tool/file activity · ⏳ waiting for terminal\n" +
    "🟠 your follow-up is queued for the next tool boundary\n" +
    "🧶 context is compacting · 🖼️ an image was viewed\n\n" +
    "<b>Aliases</b>\n" +
    "<code>/codex_new</code>, <code>/codex_rename</code>, " +
    "<code>/codex_interrupt</code>, <code>/codex_screen</code>, " +
    "<code>/codex_key</code>, <code>/codex_detach</code>"
  );
}

export function formatCodexEvent(event: CodexEvent): string[] {
  const bodyChunks = renderTelegramMarkdownChunks(
    event.message,
    TELEGRAM_SAFE_TEXT_CHARS,
  );
  const assistantIcon = event.assistantName === "Lobby" ? "🪄" : "🪩";
  const heading =
    event.kind === "user_local"
      ? "✍🏻 <b>You · VPS</b>\n\n"
      : event.kind === "assistant_progress"
        ? `${assistantIcon} <b>${event.assistantName} · update</b>\n\n`
        : `${assistantIcon} <b>${event.assistantName} · fin</b>\n\n`;
  return bodyChunks.map(
    (chunk, index) =>
      `${index === 0 ? heading : ""}${chunk}`,
  );
}

export function formatCodexRichMarkdown(event: CodexEvent): string {
  const assistantIcon = event.assistantName === "Lobby" ? "🪄" : "🪩";
  const heading =
    event.kind === "user_local"
      ? "✍🏻 **You · VPS**"
      : event.kind === "assistant_progress"
        ? `${assistantIcon} **${event.assistantName} · update**`
        : `${assistantIcon} **${event.assistantName} · fin**`;
  const body = event.message
    .replace(/\u0000/gu, "�")
    .trim() || "(Codex finished without a text response.)";
  return `${heading}\n\n${body}`;
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
