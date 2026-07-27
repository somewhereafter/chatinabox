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
  tgEditForumTopic,
  tgEditForumTopicIcon,
  tgEditRichHtml,
  tgGetForumTopicIconStickers,
  tgSend,
  tgSendRichHtml,
} from "../telegram";
import type {
  TelegramCallbackQuery,
  TelegramMessage,
} from "../telegram-types";
import {
  normalizeAssistantName,
  samePaneIdentity,
  type CodexPane,
} from "./codex-bridge-protocol";
import { CodexBridgeClient } from "./codex-bridge-client";
import type { ChatinaboxEnv } from "./env";
import {
  DEFAULT_EXPERIENCE_PROFILE,
  type ExperienceProfile,
} from "./experience-profile";
import { abortableSleep } from "./sleep";
import type {
  CodexAttachmentRow,
  ChatinaboxStore,
  TopicSetupRow,
} from "./store";

const SETUP_CALLBACK_TTL_MS = 24 * 60 * 60 * 1_000;
const RESTART_CALLBACK_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const TOPIC_PRESENCE_POLL_MS = 30_000;
const TOPIC_WAKE_READY_BUFFER_MS = 900;
const MODELS = ["sol", "luna", "terra"] as const;
const EFFORTS = ["low", "medium", "high", "xhigh"] as const;

type BridgeClient = Pick<CodexBridgeClient, "request">;

interface TopicSessionDependencies {
  readonly env: ChatinaboxEnv;
  readonly store: ChatinaboxStore;
  readonly bridge?: BridgeClient;
  readonly now?: () => number;
  readonly readyBufferMs?: number;
  readonly profile?: () => ExperienceProfile;
}

interface StatusIcons {
  readonly working: string;
  readonly done: string;
  readonly closed: string;
}

export class TopicSessionController {
  private readonly bridge: BridgeClient;
  private readonly now: () => number;
  private readonly readyBufferMs: number;
  private readonly profile: () => ExperienceProfile;
  private readonly starting = new Set<string>();
  private statusIcons: StatusIcons | null | undefined;
  private statusIconEmojis = "";

  constructor(private readonly dependencies: TopicSessionDependencies) {
    this.bridge =
      dependencies.bridge ??
      new CodexBridgeClient(dependencies.env.CODEX_BRIDGE_SOCKET);
    this.now = dependencies.now ?? Date.now;
    this.readyBufferMs =
      dependencies.readyBufferMs ?? TOPIC_WAKE_READY_BUFFER_MS;
    this.profile = dependencies.profile ?? (() => DEFAULT_EXPERIENCE_PROFILE);
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.refreshPresence().catch(() => undefined);
      await abortableSleep(TOPIC_PRESENCE_POLL_MS, signal)
        .catch(() => undefined);
    }
  }

  async refreshPresence(): Promise<void> {
    const icons = await this.loadStatusIcons();
    if (!icons) return;
    const listed = await this.bridge.request({ op: "list" }).catch(() => null);
    const panes = listed?.ok && "panes" in listed ? listed.panes : [];
    for (const attachment of this.dependencies.store.codexAttachments()) {
      if (attachment.chat_id >= 0 || attachment.message_thread_id <= 0) {
        continue;
      }
      const manager = this.dependencies.store.managerTopic(attachment.chat_id);
      if (manager?.message_thread_id === attachment.message_thread_id) {
        continue;
      }
      const pane = panes.find((candidate) =>
        samePaneIdentity(candidate, {
          serverPid: attachment.server_pid,
          paneId: attachment.pane_id,
          panePid: attachment.pane_pid,
        })
      );
      const activeTurn =
        this.dependencies.store.codexStatus(
          attachment.chat_id,
          attachment.owner_user_id,
          {
            serverPid: attachment.server_pid,
            paneId: attachment.pane_id,
            panePid: attachment.pane_pid,
          },
        ) !== null;
      const activeGoal = this.dependencies.store.hasActiveCodexGoal(
        attachment.chat_id,
        attachment.owner_user_id,
        attachment.message_thread_id,
      );
      let row = this.dependencies.store.ensureTopicSetup(
        attachment.chat_id,
        attachment.owner_user_id,
        attachment.message_thread_id,
        attachment.window_name,
        attachment.cwd,
        sessionDefaults(this.profile()),
      );
      if (pane && attachment.window_name !== pane.windowName) {
        this.dependencies.store.renameAttachedCodexTarget(
          {
            serverPid: attachment.server_pid,
            paneId: attachment.pane_id,
            panePid: attachment.pane_pid,
          },
          pane,
        );
      }
      if (pane && row.topic_name !== pane.windowName) {
        row = this.dependencies.store.updateTopicSetup(
          row.chat_id,
          row.owner_user_id,
          row.message_thread_id,
          { topic_name: pane.windowName },
        ) ?? row;
      }
      if (pane?.busy === true || activeTurn || activeGoal) {
        if (row.idle_since !== 0) {
          row = this.dependencies.store.updateTopicSetup(
            row.chat_id,
            row.owner_user_id,
            row.message_thread_id,
            { idle_since: 0 },
          ) ?? row;
        }
        await this.setTopicIconStatus(row, "working", icons);
        continue;
      }
      if (row.idle_since === 0) {
        row = this.dependencies.store.updateTopicSetup(
          row.chat_id,
          row.owner_user_id,
          row.message_thread_id,
          { idle_since: this.now() },
        ) ?? row;
      }
      const idleCloseMs =
        this.profile().sessions.idleCloseMinutes * 60 * 1_000;
      if (
        idleCloseMs > 0 &&
        this.now() - row.idle_since >= idleCloseMs
      ) {
        await this.closeInactiveTopic(row, attachment, icons);
      } else if (
        row.last_icon_status === "working" &&
        this.now() - row.idle_since < TOPIC_PRESENCE_POLL_MS
      ) {
        continue;
      } else {
        await this.setTopicIconStatus(row, "done", icons);
      }
    }
  }

  async handleMessage(
    message: TelegramMessage,
    command: { readonly name: string; readonly argument: string } | null,
  ): Promise<boolean> {
    const identity = topicIdentity(message);
    if (!identity) return false;

    if (message.forum_topic_created) {
      const name = normalizeTopicName(message.forum_topic_created.name);
      if (name) {
        this.remember(identity, name);
        await this.openSetup(message, identity);
      }
      return true;
    }

    const editedName = normalizeTopicName(message.forum_topic_edited?.name);
    if (editedName) {
      await this.syncRenamedTopic(identity, editedName, message.message_id);
      return true;
    }

    if (command?.name === "setup") {
      await this.openSetup(message, identity);
      return true;
    }

    const attachment = this.dependencies.store.codexAttachment(
      identity.chatId,
      identity.ownerUserId,
      identity.messageThreadId,
    );
    if (attachment && typeof message.text === "string") {
      this.dependencies.store.updateTopicSetup(
        identity.chatId,
        identity.ownerUserId,
        identity.messageThreadId,
        { idle_since: 0 },
      );
    }

    const setup = this.dependencies.store.topicSetup(
      identity.chatId,
      identity.ownerUserId,
      identity.messageThreadId,
    );
    if (
      setup?.awaiting &&
      command === null &&
      typeof message.text === "string"
    ) {
      await this.acceptSetupInput(message, setup);
      return true;
    }
    if (
      !attachment &&
      setup?.closed_at &&
      command === null &&
      (
        typeof message.text === "string" ||
        Boolean(message.photo?.length) ||
        Boolean(message.document)
      )
    ) {
      // Returning false after a successful wake lets the normal Codex router
      // relay this exact Telegram update. A failed wake consumes it after
      // explicitly telling the user that it was not sent.
      return !await this.wakeTopicForMessage(message, setup);
    }
    return false;
  }

  private async wakeTopicForMessage(
    message: TelegramMessage,
    setup: TopicSetupRow,
  ): Promise<boolean> {
    let notice = await tgSendRichHtml(
      this.dependencies.env,
      setup.chat_id,
      formatMessageWakeCard(setup),
      message.message_id,
      undefined,
      setup.message_thread_id,
    ).catch(() => null);
    if (!notice?.ok) {
      notice = await tgSend(
        this.dependencies.env,
        setup.chat_id,
        `↻ <b>Resuming ${escapeTelegramHtml(setup.topic_name)}…</b>\n` +
          "I’ll send your message as soon as the session is ready.",
        message.message_id,
        undefined,
        setup.message_thread_id,
      ).catch(() => null);
    }
    const noticeMessageId = notice?.ok
      ? notice.result.message_id
      : setup.resting_message_id ?? message.message_id;

    await this.restartTopicSession(
      setup.chat_id,
      setup.owner_user_id,
      setup.message_thread_id,
      noticeMessageId,
    );
    const attachment = this.dependencies.store.codexAttachment(
      setup.chat_id,
      setup.owner_user_id,
      setup.message_thread_id,
    );
    if (!attachment) {
      const keyboard = await this.restartKeyboard(setup)
        .catch(() => undefined);
      const html = formatMessageWakeFailure(setup);
      if (notice?.ok) {
        await tgEditRichHtml(
          this.dependencies.env,
          setup.chat_id,
          notice.result.message_id,
          html,
          keyboard,
        ).catch(() => undefined);
      } else {
        await tgSendRichHtml(
          this.dependencies.env,
          setup.chat_id,
          html,
          message.message_id,
          keyboard,
          setup.message_thread_id,
        ).catch(() => undefined);
      }
      return false;
    }

    if (this.readyBufferMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.readyBufferMs);
        timer.unref();
      });
    }
    if (notice?.ok) {
      await tgEditRichHtml(
        this.dependencies.env,
        setup.chat_id,
        notice.result.message_id,
        formatMessageWakeReady(setup),
        emptyKeyboard(),
      ).catch(() => undefined);
    }
    return true;
  }

  async handleCallback(callback: TelegramCallbackQuery): Promise<boolean> {
    const chatId = callback.message?.chat.id;
    const messageId = callback.message?.message_id;
    const messageThreadId = topicThreadId(callback.message ?? {});
    const ownerUserId = callback.from.id;
    if (
      !Number.isSafeInteger(chatId) ||
      chatId! >= 0 ||
      !Number.isSafeInteger(messageId) ||
      messageId! <= 0 ||
      messageThreadId <= 0 ||
      !Number.isSafeInteger(ownerUserId) ||
      ownerUserId <= 0 ||
      typeof callback.data !== "string"
    ) {
      return false;
    }
    const parsed = await parseCallbackReference(
      this.dependencies.store.callbackStore(),
      callback.data,
      { chatId: chatId!, userId: ownerUserId },
    );
    if (!parsed.ok || !parsed.value.action.startsWith("topic_setup.")) {
      return false;
    }
    await tgAnswerCallbackQuery(this.dependencies.env, callback.id, {
      text: setupCallbackAnswer(parsed.value.action),
      cacheTime: 0,
    }).catch(() => undefined);

    const row = this.dependencies.store.ensureTopicSetup(
      chatId!,
      ownerUserId,
      messageThreadId,
      "new codex chat",
      this.dependencies.env.DEFAULT_CWD,
      sessionDefaults(this.profile()),
    );
    const attachment = this.dependencies.store.codexAttachment(
      chatId!,
      ownerUserId,
      messageThreadId,
    );
    if (attachment) {
      await tgEditRichHtml(
        this.dependencies.env,
        chatId!,
        messageId!,
        formatAttachedCard(attachment.window_name, attachment.cwd),
        emptyKeyboard(),
      ).catch(() => undefined);
      return true;
    }

    switch (parsed.value.action) {
      case "topic_setup.model":
        this.dependencies.store.updateTopicSetup(
          chatId!,
          ownerUserId,
          messageThreadId,
          { model: cycle(MODELS, row.model) },
        );
        break;
      case "topic_setup.effort":
        this.dependencies.store.updateTopicSetup(
          chatId!,
          ownerUserId,
          messageThreadId,
          { reasoning_effort: cycle(EFFORTS, row.reasoning_effort) },
        );
        break;
      case "topic_setup.speed":
        this.dependencies.store.updateTopicSetup(
          chatId!,
          ownerUserId,
          messageThreadId,
          { fast: row.fast === 1 ? 0 : 1 },
        );
        break;
      case "topic_setup.name":
        this.dependencies.store.updateTopicSetup(
          chatId!,
          ownerUserId,
          messageThreadId,
          { awaiting: "name", starter_message_id: messageId! },
        );
        await tgSend(
          this.dependencies.env,
          chatId!,
          "✏️ Send the new topic and chat name.",
          messageId!,
          undefined,
          messageThreadId,
        );
        return true;
      case "topic_setup.cwd":
        this.dependencies.store.updateTopicSetup(
          chatId!,
          ownerUserId,
          messageThreadId,
          { awaiting: "cwd", starter_message_id: messageId! },
        );
        await tgSend(
          this.dependencies.env,
          chatId!,
          "📁 Send an absolute workspace path, for example <code>/root/project</code>.",
          messageId!,
          undefined,
          messageThreadId,
        );
        return true;
      case "topic_setup.start":
        await this.startTopicSession(
          chatId!,
          ownerUserId,
          messageThreadId,
          messageId!,
        );
        return true;
      case "topic_setup.restart":
        await this.restartTopicSession(
          chatId!,
          ownerUserId,
          messageThreadId,
          messageId!,
        );
        return true;
    }
    await this.editSetupCard(
      chatId!,
      ownerUserId,
      messageThreadId,
      messageId!,
    );
    return true;
  }

  private remember(
    identity: TopicIdentity,
    name: string,
  ): TopicSetupRow {
    return this.dependencies.store.rememberTopic(
      identity.chatId,
      identity.ownerUserId,
      identity.messageThreadId,
      name,
      this.dependencies.env.DEFAULT_CWD,
      sessionDefaults(this.profile()),
    );
  }

  private async syncRenamedTopic(
    identity: TopicIdentity,
    name: string,
    replyToMessageId: number,
  ): Promise<void> {
    this.remember(identity, name);
    const attachment = this.dependencies.store.codexAttachment(
      identity.chatId,
      identity.ownerUserId,
      identity.messageThreadId,
    );
    if (!attachment) return;
    const result = await this.bridge.request({
      op: "rename",
      target: {
        serverPid: attachment.server_pid,
        paneId: attachment.pane_id,
        panePid: attachment.pane_pid,
      },
      name,
    }).catch(() => null);
    if (result?.ok && "pane" in result) {
      this.dependencies.store.renameAttachedCodexTarget(
        {
          serverPid: attachment.server_pid,
          paneId: attachment.pane_id,
          panePid: attachment.pane_pid,
        },
        result.pane,
      );
      return;
    }
    await tgSend(
      this.dependencies.env,
      identity.chatId,
      "⚠️ The topic was renamed, but its Codex session could not be renamed.",
      replyToMessageId,
      undefined,
      identity.messageThreadId,
    ).catch(() => undefined);
  }

  private async openSetup(
    message: TelegramMessage,
    identity: TopicIdentity,
  ): Promise<void> {
    const attachment = this.dependencies.store.codexAttachment(
      identity.chatId,
      identity.ownerUserId,
      identity.messageThreadId,
    );
    if (attachment) {
      await tgSendRichHtml(
        this.dependencies.env,
        identity.chatId,
        formatAttachedCard(attachment.window_name, attachment.cwd),
        message.message_id,
        undefined,
        identity.messageThreadId,
      );
      return;
    }
    const current = this.dependencies.store.ensureTopicSetup(
      identity.chatId,
      identity.ownerUserId,
      identity.messageThreadId,
      "new codex chat",
      this.dependencies.env.DEFAULT_CWD,
      sessionDefaults(this.profile()),
    );
    if (current.closed_at) {
      const sent = await tgSendRichHtml(
        this.dependencies.env,
        identity.chatId,
        formatRestingCard(current),
        message.message_id,
        await this.restartKeyboard(current),
        identity.messageThreadId,
      );
      if (sent.ok) {
        this.dependencies.store.updateTopicSetup(
          identity.chatId,
          identity.ownerUserId,
          identity.messageThreadId,
          { resting_message_id: sent.result.message_id },
        );
      }
      return;
    }
    this.dependencies.store.updateTopicSetup(
      identity.chatId,
      identity.ownerUserId,
      identity.messageThreadId,
      { awaiting: "" },
    );
    const keyboard = await this.setupKeyboard(current);
    const sent = await tgSendRichHtml(
      this.dependencies.env,
      identity.chatId,
      formatSetupCard(current),
      message.message_id,
      keyboard,
      identity.messageThreadId,
    );
    if (sent.ok) {
      this.dependencies.store.updateTopicSetup(
        identity.chatId,
        identity.ownerUserId,
        identity.messageThreadId,
        { starter_message_id: sent.result.message_id },
      );
    }
  }

  private async acceptSetupInput(
    message: TelegramMessage,
    setup: TopicSetupRow,
  ): Promise<void> {
    if (setup.awaiting === "name") {
      const name = normalizeTopicName(message.text);
      if (!name) {
        await tgSend(
          this.dependencies.env,
          setup.chat_id,
          "Use a name between 1 and 128 characters on one line.",
          message.message_id,
          undefined,
          setup.message_thread_id,
        );
        return;
      }
      const renamed = await tgEditForumTopic(
        this.dependencies.env,
        setup.chat_id,
        setup.message_thread_id,
        name,
      );
      if (!renamed.ok) {
        await tgSend(
          this.dependencies.env,
          setup.chat_id,
          "⚠️ Telegram would not rename this topic. Check the bot’s topic permission.",
          message.message_id,
          undefined,
          setup.message_thread_id,
        );
        return;
      }
      this.dependencies.store.updateTopicSetup(
        setup.chat_id,
        setup.owner_user_id,
        setup.message_thread_id,
        { topic_name: name, awaiting: "" },
      );
    } else {
      const cwd = normalizeWorkspace(message.text);
      if (!cwd) {
        await tgSend(
          this.dependencies.env,
          setup.chat_id,
          "Use an absolute path such as <code>/root/project</code>.",
          message.message_id,
          undefined,
          setup.message_thread_id,
        );
        return;
      }
      this.dependencies.store.updateTopicSetup(
        setup.chat_id,
        setup.owner_user_id,
        setup.message_thread_id,
        { cwd, awaiting: "" },
      );
    }
    if (setup.starter_message_id) {
      await this.editSetupCard(
        setup.chat_id,
        setup.owner_user_id,
        setup.message_thread_id,
        setup.starter_message_id,
      );
    }
    await tgSend(
      this.dependencies.env,
      setup.chat_id,
      "✓ setup updated",
      message.message_id,
      undefined,
      setup.message_thread_id,
    );
  }

  private async startTopicSession(
    chatId: number,
    ownerUserId: number,
    messageThreadId: number,
    messageId: number,
  ): Promise<void> {
    const key = `${chatId}:${ownerUserId}:${messageThreadId}`;
    if (this.starting.has(key)) return;
    this.starting.add(key);
    try {
      if (this.dependencies.store.codexAttachment(
        chatId,
        ownerUserId,
        messageThreadId,
      )) {
        return;
      }
      const row = this.dependencies.store.topicSetup(
        chatId,
        ownerUserId,
        messageThreadId,
      );
      if (!row) return;
      await tgEditRichHtml(
        this.dependencies.env,
        chatId,
        messageId,
        formatStartingCard(row),
        emptyKeyboard(),
      ).catch(() => undefined);
      const result = await this.bridge.request({
        op: "new",
        name: row.topic_name,
        cwd: row.cwd,
        model: row.model,
        reasoningEffort: row.reasoning_effort,
        fast: row.fast === 1,
      }).catch(() => null);
      if (!result?.ok || !("pane" in result)) {
        await this.editSetupCard(
          chatId,
          ownerUserId,
          messageThreadId,
          messageId,
          result && !result.ok ? result.error : undefined,
        );
        return;
      }
      this.dependencies.store.attachCodex(
        chatId,
        ownerUserId,
        result.pane,
        messageThreadId,
      );
      this.dependencies.store.updateTopicSetup(
        chatId,
        ownerUserId,
        messageThreadId,
        {
          awaiting: "",
          starter_message_id: messageId,
          idle_since: this.now(),
          closed_session_id: null,
          closed_at: null,
          resting_message_id: null,
        },
      );
      const icons = await this.loadStatusIcons();
      const updated = this.dependencies.store.topicSetup(
        chatId,
        ownerUserId,
        messageThreadId,
      );
      if (icons && updated) {
        await this.setTopicIconStatus(updated, "done", icons);
      }
      await tgEditRichHtml(
        this.dependencies.env,
        chatId,
        messageId,
        formatStartedCard(row, result.pane),
        emptyKeyboard(),
      );
    } finally {
      this.starting.delete(key);
    }
  }

  private async closeInactiveTopic(
    row: TopicSetupRow,
    attachment: CodexAttachmentRow,
    icons: StatusIcons,
  ): Promise<void> {
    const target = {
      serverPid: attachment.server_pid,
      paneId: attachment.pane_id,
      panePid: attachment.pane_pid,
    };
    const closed = await this.bridge.request({
      op: "close",
      target,
    }).catch(() => null);
    if (!closed?.ok || !("closed" in closed)) return;
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
    this.dependencies.store.detachCodex(
      attachment.chat_id,
      attachment.owner_user_id,
      attachment.message_thread_id,
    );
    let updated = this.dependencies.store.updateTopicSetup(
      row.chat_id,
      row.owner_user_id,
      row.message_thread_id,
      {
        model: closed.profile.model,
        reasoning_effort: closed.profile.reasoningEffort,
        fast: closed.profile.fast ? 1 : 0,
        cwd: closed.profile.cwd,
        idle_since: 0,
        closed_session_id: closed.sessionId,
        closed_at: this.now(),
        resting_message_id: null,
        last_icon_status: "",
      },
    );
    if (!updated) return;
    await this.setTopicIconStatus(updated, "closed", icons);
    updated = this.dependencies.store.topicSetup(
      row.chat_id,
      row.owner_user_id,
      row.message_thread_id,
    ) ?? updated;
    const sent = await tgSendRichHtml(
      this.dependencies.env,
      row.chat_id,
      formatRestingCard(updated),
      undefined,
      await this.restartKeyboard(updated),
      row.message_thread_id,
    );
    if (sent.ok) {
      this.dependencies.store.updateTopicSetup(
        row.chat_id,
        row.owner_user_id,
        row.message_thread_id,
        { resting_message_id: sent.result.message_id },
      );
    }
  }

  private async restartTopicSession(
    chatId: number,
    ownerUserId: number,
    messageThreadId: number,
    messageId: number,
  ): Promise<void> {
    const key = `${chatId}:${ownerUserId}:${messageThreadId}`;
    if (this.starting.has(key)) return;
    this.starting.add(key);
    try {
      if (this.dependencies.store.codexAttachment(
        chatId,
        ownerUserId,
        messageThreadId,
      )) return;
      const row = this.dependencies.store.topicSetup(
        chatId,
        ownerUserId,
        messageThreadId,
      );
      if (!row?.closed_at) return;
      await tgEditRichHtml(
        this.dependencies.env,
        chatId,
        messageId,
        formatRestartingCard(row),
        emptyKeyboard(),
      ).catch(() => undefined);
      const profile = {
        name: row.topic_name,
        cwd: row.cwd,
        model: row.model,
        reasoningEffort: row.reasoning_effort,
        fast: row.fast === 1,
      } as const;
      let launched = row.closed_session_id
        ? await this.bridge.request({
            op: "resume",
            sessionId: row.closed_session_id,
            ...profile,
          }).catch(() => null)
        : null;
      if (!launched?.ok || !("pane" in launched)) {
        launched = await this.bridge.request({
          op: "new",
          ...profile,
        }).catch(() => null);
      }
      if (!launched?.ok || !("pane" in launched)) {
        await tgEditRichHtml(
          this.dependencies.env,
          chatId,
          messageId,
          formatRestingCard(row, "Restart failed. Tap to try again."),
          await this.restartKeyboard(row),
        );
        return;
      }
      this.dependencies.store.attachCodex(
        chatId,
        ownerUserId,
        launched.pane,
        messageThreadId,
      );
      this.dependencies.store.updateTopicSetup(
        chatId,
        ownerUserId,
        messageThreadId,
        {
          idle_since: this.now(),
          closed_session_id: null,
          closed_at: null,
          resting_message_id: null,
          last_icon_status: "",
        },
      );
      const icons = await this.loadStatusIcons();
      const updated = this.dependencies.store.topicSetup(
        chatId,
        ownerUserId,
        messageThreadId,
      );
      if (icons && updated) {
        await this.setTopicIconStatus(updated, "done", icons);
      }
      await tgEditRichHtml(
        this.dependencies.env,
        chatId,
        messageId,
        formatBackOnlineCard(row, launched.pane),
        emptyKeyboard(),
      );
    } finally {
      this.starting.delete(key);
    }
  }

  private async editSetupCard(
    chatId: number,
    ownerUserId: number,
    messageThreadId: number,
    messageId: number,
    error?: string,
  ): Promise<void> {
    const row = this.dependencies.store.topicSetup(
      chatId,
      ownerUserId,
      messageThreadId,
    );
    if (!row) return;
    await tgEditRichHtml(
      this.dependencies.env,
      chatId,
      messageId,
      formatSetupCard(row, error),
      await this.setupKeyboard(row),
    ).catch(() => undefined);
  }

  private async setupKeyboard(
    row: TopicSetupRow,
  ): Promise<TelegramInlineKeyboardMarkup> {
    const button = async (
      label: string,
      action:
        | "topic_setup.model"
        | "topic_setup.effort"
        | "topic_setup.speed"
        | "topic_setup.name"
        | "topic_setup.cwd"
        | "topic_setup.start",
    ): Promise<InlineKeyboardButtonInput> => ({
      label,
      callbackData: (
        await issueCallbackReference(this.dependencies.store.callbackStore(), {
          action,
          chatId: row.chat_id,
          userId: row.owner_user_id,
          payload: {},
          ttlMs: SETUP_CALLBACK_TTL_MS,
        })
      ).callbackData,
    });
    return buildInlineKeyboard([
      [
        await button(`☀️ ${row.model}`, "topic_setup.model"),
        await button(`🧠 ${row.reasoning_effort}`, "topic_setup.effort"),
      ],
      [
        await button(
          row.fast === 1 ? "⚡ fast" : "◇ standard",
          "topic_setup.speed",
        ),
        await button("📁 workspace", "topic_setup.cwd"),
      ],
      [await button("✏️ rename topic", "topic_setup.name")],
      [await button("🚀 start chat", "topic_setup.start")],
    ]);
  }

  private async restartKeyboard(
    row: TopicSetupRow,
  ): Promise<TelegramInlineKeyboardMarkup> {
    const issued = await issueCallbackReference(
      this.dependencies.store.callbackStore(),
      {
        action: "topic_setup.restart",
        chatId: row.chat_id,
        userId: row.owner_user_id,
        payload: {},
        ttlMs: RESTART_CALLBACK_TTL_MS,
      },
    );
    return buildInlineKeyboard([
      [{ label: "↻  restart session", callbackData: issued.callbackData }],
    ]);
  }

  private async loadStatusIcons(): Promise<
    StatusIcons | null
  > {
    const profile = this.profile();
    const iconEmojis = [
      profile.sessions.workingIconEmoji,
      profile.sessions.doneIconEmoji,
      profile.sessions.closedIconEmoji,
    ].join("\u001f");
    if (
      this.statusIcons !== undefined &&
      this.statusIconEmojis === iconEmojis
    ) return this.statusIcons;
    this.statusIconEmojis = iconEmojis;
    const response = await tgGetForumTopicIconStickers(
      this.dependencies.env,
    ).catch(() => null);
    if (!response?.ok || !Array.isArray(response.result)) {
      this.statusIcons = null;
      return null;
    }
    const working = response.result.find(
      (sticker) => sticker.emoji === profile.sessions.workingIconEmoji,
    )?.custom_emoji_id;
    const done = response.result.find(
      (sticker) => sticker.emoji === profile.sessions.doneIconEmoji,
    )?.custom_emoji_id;
    const closed = response.result.find(
      (sticker) => sticker.emoji === profile.sessions.closedIconEmoji,
    )?.custom_emoji_id;
    this.statusIcons =
      working && done && closed ? { working, done, closed } : null;
    return this.statusIcons;
  }

  private async setTopicIconStatus(
    row: TopicSetupRow,
    status: "working" | "done" | "closed",
    icons: StatusIcons,
  ): Promise<void> {
    if (row.last_icon_status === status) return;
    const edited = await tgEditForumTopicIcon(
      this.dependencies.env,
      row.chat_id,
      row.message_thread_id,
      icons[status],
    );
    if (!edited.ok) return;
    this.dependencies.store.updateTopicSetup(
      row.chat_id,
      row.owner_user_id,
      row.message_thread_id,
      { last_icon_status: status },
    );
  }
}

interface TopicIdentity {
  readonly chatId: number;
  readonly ownerUserId: number;
  readonly messageThreadId: number;
}

function topicIdentity(message: TelegramMessage): TopicIdentity | null {
  const threadId = topicThreadId(message);
  const ownerUserId = message.from?.id;
  return Number.isSafeInteger(message.chat.id) &&
      message.chat.id < 0 &&
      Number.isSafeInteger(ownerUserId) &&
      ownerUserId! > 0 &&
      threadId > 0
    ? {
        chatId: message.chat.id,
        ownerUserId: ownerUserId!,
        messageThreadId: threadId,
      }
    : null;
}

export function topicThreadId(
  message: Pick<TelegramMessage, "message_thread_id">,
): number {
  return Number.isSafeInteger(message.message_thread_id) &&
      message.message_thread_id! > 0
    ? message.message_thread_id!
    : 0;
}

export function normalizeTopicName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/gu, " ").trim();
  const length = [...normalized].length;
  return length >= 1 && length <= 128 ? normalized : null;
}

export function normalizeWorkspace(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > 1_024 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) return null;
  const trimmed = value.trim();
  if (!path.posix.isAbsolute(trimmed)) return null;
  return path.posix.normalize(trimmed);
}

export function formatSetupCard(
  row: TopicSetupRow,
  error?: string,
): string {
  return (
    "<mark>new chat · setup</mark>\n\n" +
    `<b>${escapeTelegramHtml(row.topic_name)}</b>\n` +
    "<blockquote>" +
    `model · ${row.model}\n` +
    `reasoning · ${row.reasoning_effort}\n` +
    `speed · ${row.fast === 1 ? "fast" : "standard"}\n` +
    `workspace · <code>${escapeTelegramHtml(row.cwd)}</code>` +
    "</blockquote>\n\n" +
    (error ? `⚠️ ${escapeTelegramHtml(error)}\n\n` : "") +
    "Tune anything below, then start.\n\n" +
    "<footer>the topic name becomes the chat name</footer>"
  );
}

export function formatMessageWakeCard(row: TopicSetupRow): string {
  return (
    `↻ <b>Resuming ${escapeTelegramHtml(row.topic_name)}…</b>\n\n` +
    "I’ll send your message as soon as the session is ready."
  );
}

export function formatMessageWakeReady(row: TopicSetupRow): string {
  return (
    `✓ <b>${escapeTelegramHtml(row.topic_name)} is back online.</b>\n` +
    "Sending your message now…"
  );
}

export function formatMessageWakeFailure(row: TopicSetupRow): string {
  return (
    `⚠️ <b>${escapeTelegramHtml(row.topic_name)} could not resume.</b>\n\n` +
    "Your message was not sent. Tap below to try again, then resend it."
  );
}

function formatStartingCard(row: TopicSetupRow): string {
  return (
    "<mark>starting chat…</mark>\n\n" +
    `<b>${escapeTelegramHtml(row.topic_name)}</b>\n` +
    `${row.model} · ${row.reasoning_effort} · ` +
    `${row.fast === 1 ? "fast" : "standard"}`
  );
}

function formatStartedCard(row: TopicSetupRow, pane: CodexPane): string {
  return (
    `<mark>${normalizeAssistantName(pane.assistantName).toLowerCase()} · ready</mark>\n\n` +
    `<b>${escapeTelegramHtml(row.topic_name)}</b>\n` +
    "<blockquote>" +
    `${row.model} · ${row.reasoning_effort} · ` +
    `${row.fast === 1 ? "fast" : "standard"}\n` +
    `<code>${escapeTelegramHtml(row.cwd)}</code>` +
    "</blockquote>\n\n" +
    "Send the first message whenever you’re ready."
  );
}

function formatAttachedCard(name: string, cwd: string): string {
  return (
    "<mark>chat · connected</mark>\n\n" +
    `<b>${escapeTelegramHtml(name)}</b>\n` +
    `<code>${escapeTelegramHtml(cwd)}</code>\n\n` +
    "This topic already has a live Codex session."
  );
}

function formatRestingCard(row: TopicSetupRow, note?: string): string {
  return (
    "<mark>session · resting</mark>\n\n" +
    `<b>${escapeTelegramHtml(row.topic_name)}</b>\n` +
    "<blockquote>Closed after its inactivity window.\n" +
    "Its Codex history and launch profile are saved.</blockquote>\n\n" +
    (note ? `${escapeTelegramHtml(note)}\n\n` : "") +
    "<footer>tap below whenever you want it back</footer>"
  );
}

function formatRestartingCard(row: TopicSetupRow): string {
  return (
    "<mark>session · waking…</mark>\n\n" +
    `<b>${escapeTelegramHtml(row.topic_name)}</b>\n` +
    `${row.model} · ${row.reasoning_effort} · ` +
    `${row.fast === 1 ? "fast" : "standard"}`
  );
}

function formatBackOnlineCard(row: TopicSetupRow, pane: CodexPane): string {
  return (
    `<mark>${normalizeAssistantName(pane.assistantName).toLowerCase()} · back online</mark>\n\n` +
    `<b>${escapeTelegramHtml(row.topic_name)}</b>\n` +
    `<code>${escapeTelegramHtml(row.cwd)}</code>\n\n` +
    "History restored. Send a message whenever you’re ready."
  );
}

function emptyKeyboard(): TelegramInlineKeyboardMarkup {
  return { inline_keyboard: [] };
}

function cycle<T extends string>(
  values: readonly T[],
  current: T,
): T {
  const index = values.indexOf(current);
  return values[(index + 1) % values.length]!;
}

function sessionDefaults(profile: ExperienceProfile): {
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

function setupCallbackAnswer(action: string): string {
  switch (action) {
    case "topic_setup.start":
      return "Starting chat…";
    case "topic_setup.name":
      return "Send a new name";
    case "topic_setup.cwd":
      return "Send a workspace path";
    case "topic_setup.restart":
      return "Waking session…";
    default:
      return "Updated";
  }
}
