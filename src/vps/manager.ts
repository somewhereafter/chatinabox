import {
  escapeTelegramHtml,
  tgEditForumTopic,
  tgEditForumTopicIcon,
  tgGetForumTopicIconStickers,
  tgSend,
  tgSendRichHtml,
} from "../telegram";
import type { TelegramMessage } from "../telegram-types";
import {
  samePaneIdentity,
  type CodexPane,
  type CodexPaneIdentity,
} from "./codex-bridge-protocol";
import { CodexBridgeClient } from "./codex-bridge-client";
import type { ChatinaboxEnv } from "./env";
import {
  DEFAULT_EXPERIENCE_PROFILE,
  type ExperienceProfile,
} from "./experience-profile";
import {
  retireWorkTopicSetup,
  sendControlTopicConflict,
} from "./control-topics";
import type { ChatinaboxStore, ManagerTopicRow } from "./store";

type BridgeClient = Pick<CodexBridgeClient, "request">;

interface ManagerDependencies {
  readonly env: ChatinaboxEnv;
  readonly store: ChatinaboxStore;
  readonly bridge?: BridgeClient;
  readonly profile?: () => ExperienceProfile;
}

export class ManagerController {
  private readonly bridge: BridgeClient;
  private readonly ensuring = new Map<number, Promise<CodexPane | null>>();
  private readonly profile: () => ExperienceProfile;

  constructor(private readonly dependencies: ManagerDependencies) {
    this.bridge =
      dependencies.bridge ??
      new CodexBridgeClient(dependencies.env.CODEX_BRIDGE_SOCKET);
    this.profile = dependencies.profile ?? (() => DEFAULT_EXPERIENCE_PROFILE);
  }

  isManagerChat(chatId: number): boolean {
    return this.dependencies.store.isManagerChat(chatId);
  }

  isManagerMessage(
    message: Pick<TelegramMessage, "chat" | "message_thread_id">,
  ): boolean {
    const row = this.dependencies.store.managerTopic(message.chat.id);
    return row !== null &&
      row.message_thread_id === managerThreadId(message);
  }

  async handleCommand(
    message: TelegramMessage,
    command: { readonly name: string; readonly argument: string },
  ): Promise<boolean> {
    if (command.name !== "wizard" && command.name !== "manager") return false;
    const manager = this.profile().manager;
    const chatId = message.chat.id;
    const ownerUserId = message.from?.id;
    if (
      !Number.isSafeInteger(chatId) ||
      chatId >= 0 ||
      !Number.isSafeInteger(ownerUserId) ||
      ownerUserId! <= 0
    ) {
      await tgSend(
        this.dependencies.env,
        chatId,
        `${escapeTelegramHtml(manager.emoji)} Run ` +
          `<code>/manager setup</code> inside the ` +
          `${escapeTelegramHtml(manager.role)} forum topic.`,
        message.message_id,
      ).catch(() => undefined);
      return true;
    }
    const threadId = managerThreadId(message);
    if (threadId <= 0) {
      await tgSend(
        this.dependencies.env,
        chatId,
        `${escapeTelegramHtml(manager.emoji)} Run ` +
          `<code>/manager setup</code> inside a ` +
          "dedicated forum topic.",
        message.message_id,
      );
      return true;
    }
    const subcommand = command.argument.trim().toLowerCase();
    if (subcommand && subcommand !== "setup" && subcommand !== "wake") {
      await tgSend(
        this.dependencies.env,
        chatId,
        "Use <code>/manager setup</code> or <code>/manager wake</code>.",
        message.message_id,
      );
      return true;
    }
    const existing = this.dependencies.store.managerTopic(chatId);
    if (!existing && subcommand !== "setup") {
      await tgSend(
        this.dependencies.env,
        chatId,
        "Run <code>/forum setup</code> in General for the easiest setup, or " +
          "<code>/manager setup</code> here to use this topic.",
        message.message_id,
        undefined,
        threadId,
      );
      return true;
    }
    if (existing && existing.message_thread_id !== threadId) {
      await sendControlTopicConflict(
        this.dependencies.env,
        chatId,
        message.message_id,
        threadId,
        "manager",
        existing.message_thread_id,
      );
      return true;
    }
    await this.setupTopic(
      chatId,
      ownerUserId!,
      threadId,
      message.message_id,
    );
    return true;
  }

  async setupTopic(
    chatId: number,
    ownerUserId: number,
    messageThreadId: number,
    replyToMessageId?: number,
  ): Promise<boolean> {
    const manager = this.profile().manager;
    const existing = this.dependencies.store.managerTopic(chatId);
    if (existing && existing.message_thread_id !== messageThreadId) {
      return false;
    }
    await retireWorkTopicSetup(
      this.dependencies.env,
      this.dependencies.store,
      chatId,
      ownerUserId,
      messageThreadId,
      "manager",
      { detach: !existing },
    );
    const row = this.dependencies.store.registerManagerTopic(
      chatId,
      ownerUserId,
      messageThreadId,
    );
    const pane = await this.ensureRowAttached(row);
    if (!pane) {
      await tgSend(
        this.dependencies.env,
        chatId,
        `⚠️ ${escapeTelegramHtml(manager.name)} could not wake yet. ` +
          "Try again in a moment.",
        replyToMessageId,
        undefined,
        messageThreadId,
      );
      return false;
    }
    await this.syncIdentity(chatId, messageThreadId, pane);
    await tgSendRichHtml(
      this.dependencies.env,
      chatId,
      formatManagerWelcome(this.profile()),
      replyToMessageId,
      undefined,
      messageThreadId,
    );
    return true;
  }

  private async applyTopicIcon(
    chatId: number,
    messageThreadId: number,
  ): Promise<void> {
    const emoji = this.profile().manager.topicIconEmoji;
    const stickers = await tgGetForumTopicIconStickers(
      this.dependencies.env,
    ).catch(() => null);
    const iconId = stickers?.ok && Array.isArray(stickers.result)
      ? stickers.result.find((sticker) => sticker.emoji === emoji)
        ?.custom_emoji_id
      : undefined;
    if (!iconId) return;
    await tgEditForumTopicIcon(
      this.dependencies.env,
      chatId,
      messageThreadId,
      iconId,
    ).catch(() => undefined);
  }

  private async syncIdentity(
    chatId: number,
    messageThreadId: number,
    pane: CodexPane,
  ): Promise<void> {
    const profile = this.profile();
    await Promise.all([
      this.applyTopicIcon(chatId, messageThreadId),
      tgEditForumTopic(
        this.dependencies.env,
        chatId,
        messageThreadId,
        profile.manager.topicName,
      ).catch(() => undefined),
    ]);
    if (pane.windowName === profile.manager.topicName) return;
    const renamed = await this.bridge.request({
      op: "rename",
      target: pane,
      name: profile.manager.topicName,
    }).catch(() => null);
    if (!renamed?.ok || !("pane" in renamed)) return;
    this.dependencies.store.renameAttachedCodexTarget(pane, renamed.pane);
    this.dependencies.store.setManagerTarget(chatId, renamed.pane);
  }

  async ensureAttached(message: TelegramMessage): Promise<boolean> {
    const row = this.dependencies.store.managerTopic(message.chat.id);
    if (
      !row ||
      row.owner_user_id !== message.from?.id ||
      row.message_thread_id !== managerThreadId(message)
    ) {
      return false;
    }
    return (await this.ensureRowAttached(row)) !== null;
  }

  private ensureRowAttached(row: ManagerTopicRow): Promise<CodexPane | null> {
    const active = this.ensuring.get(row.chat_id);
    if (active) return active;
    const pending = this.ensureRowAttachedNow(row).finally(() => {
      this.ensuring.delete(row.chat_id);
    });
    this.ensuring.set(row.chat_id, pending);
    return pending;
  }

  private async ensureRowAttachedNow(
    row: ManagerTopicRow,
  ): Promise<CodexPane | null> {
    const listed = await this.bridge.request({ op: "list" }).catch(() => null);
    const panes =
      listed?.ok && "panes" in listed ? listed.panes : [];
    const storedTarget = managerTarget(row);
    let pane = storedTarget
      ? panes.find((candidate) => samePaneIdentity(candidate, storedTarget))
      : undefined;
    if (!pane) {
      const profile = this.profile();
      const created = await this.bridge.request({
        op: "new",
        name: profile.manager.topicName,
        cwd: profile.manager.cwd,
        model: profile.manager.model,
        reasoningEffort: profile.manager.reasoningEffort,
        fast: profile.manager.fast,
      }).catch(() => null);
      if (!created?.ok || !("pane" in created)) return null;
      pane = created.pane;
      this.dependencies.store.setManagerTarget(row.chat_id, pane);
    }
    this.dependencies.store.attachCodex(
      row.chat_id,
      row.owner_user_id,
      pane,
      row.message_thread_id,
    );
    return pane;
  }
}

export function managerThreadId(
  message: Pick<TelegramMessage, "message_thread_id">,
): number {
  return Number.isSafeInteger(message.message_thread_id) &&
      message.message_thread_id! > 0
    ? message.message_thread_id!
    : 0;
}

export function formatManagerWelcome(
  profile: ExperienceProfile = DEFAULT_EXPERIENCE_PROFILE,
): string {
  const manager = profile.manager;
  return (
    `<mark>${escapeTelegramHtml(manager.emoji)} ` +
    `${escapeTelegramHtml(manager.name)} · awake</mark>\n\n` +
    `<blockquote><b>your Codex ${escapeTelegramHtml(manager.role)}</b>\n` +
    "sessions · workspaces · handoffs · coordination</blockquote>\n\n" +
    "Ask naturally. I can inspect what’s running, create or resume chats, " +
    "rename them, and coordinate work across your workspace.\n\n" +
    `<footer>${escapeTelegramHtml(manager.role)} · ${manager.model} · ` +
    `${manager.reasoningEffort}</footer>`
  );
}

function managerTarget(row: ManagerTopicRow): CodexPaneIdentity | null {
  return row.server_pid !== null &&
      row.pane_id !== null &&
      row.pane_pid !== null
    ? {
        serverPid: row.server_pid,
        paneId: row.pane_id,
        panePid: row.pane_pid,
      }
    : null;
}
