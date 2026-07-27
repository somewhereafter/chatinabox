import {
  escapeTelegramHtml,
  tgCreateForumTopic,
  tgSend,
} from "../telegram";
import type { TelegramMessage } from "../telegram-types";
import {
  forumTopicUrl,
} from "./control-topics";
import type { ChatinaboxEnv } from "./env";
import type {
  ExperienceProfile,
} from "./experience-profile";
import type { ManagerController } from "./manager";
import type { OverviewController } from "./overview";
import type { ChatinaboxStore } from "./store";

interface ForumSetupDependencies {
  readonly env: ChatinaboxEnv;
  readonly store: ChatinaboxStore;
  readonly overview: Pick<OverviewController, "setupTopic">;
  readonly manager: Pick<ManagerController, "setupTopic">;
  readonly profile: () => ExperienceProfile;
}

export class ForumSetupController {
  constructor(private readonly dependencies: ForumSetupDependencies) {}

  async handleCommand(
    message: TelegramMessage,
    command: { readonly name: string; readonly argument: string },
  ): Promise<boolean> {
    if (command.name !== "forum") return false;
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
        "Create a Telegram forum, add this bot as an administrator, then run " +
          "<code>/forum setup</code> in its General topic.",
        message.message_id,
      ).catch(() => undefined);
      return true;
    }
    const threadId = telegramThreadId(message);
    if (threadId > 0) {
      await tgSend(
        this.dependencies.env,
        chatId,
        "Run <code>/forum setup</code> in General. Chatinabox will use General " +
          "for the Overview and create the Manager topic for you.",
        message.message_id,
        undefined,
        threadId,
      );
      return true;
    }
    const subcommand = command.argument.trim().toLowerCase();
    if (subcommand && subcommand !== "setup") {
      await tgSend(
        this.dependencies.env,
        chatId,
        "Use <code>/forum setup</code> in General.",
        message.message_id,
      );
      return true;
    }
    const profile = this.dependencies.profile();
    if (!profile.setupComplete) {
      await tgSend(
        this.dependencies.env,
        chatId,
        "Finish the private setup first: open this bot directly and send " +
          "<code>/start</code>. Then come back here and run " +
          "<code>/forum setup</code> again.",
        message.message_id,
      );
      return true;
    }

    const existingOverview = this.dependencies.store.overviewDashboard(chatId);
    const overviewThreadId = existingOverview?.message_thread_id ?? 0;
    const overviewReady = await this.dependencies.overview.setupTopic(
      chatId,
      existingOverview?.owner_user_id ?? ownerUserId!,
      overviewThreadId,
    );
    if (!overviewReady) {
      await tgSend(
        this.dependencies.env,
        chatId,
        "⚠️ The Overview could not be prepared. Run " +
          "<code>/overview refresh</code> and try again.",
        message.message_id,
      );
      return true;
    }

    let manager = this.dependencies.store.managerTopic(chatId);
    if (!manager) {
      const created = await tgCreateForumTopic(
        this.dependencies.env,
        chatId,
        profile.manager.topicName,
      ).catch(() => null);
      if (!created?.ok) {
        await tgSend(
          this.dependencies.env,
          chatId,
          "The Overview is ready, but I could not create the Manager topic. " +
            "Give the bot permission to manage topics, then run " +
            "<code>/forum setup</code> again.",
          message.message_id,
        );
        return true;
      }
      const ready = await this.dependencies.manager.setupTopic(
        chatId,
        ownerUserId!,
        created.result.message_thread_id,
      );
      if (!ready) {
        await tgSend(
          this.dependencies.env,
          chatId,
          "The Manager topic was created, but its Codex session could not start. " +
            "Open that topic and send <code>/manager wake</code>.",
          message.message_id,
        );
        return true;
      }
      manager = this.dependencies.store.managerTopic(chatId);
    } else {
      const ready = await this.dependencies.manager.setupTopic(
        chatId,
        manager.owner_user_id,
        manager.message_thread_id,
      );
      if (!ready) {
        await tgSend(
          this.dependencies.env,
          chatId,
          "The Overview is ready, but the existing Manager could not reconnect. " +
            "Open its topic and send <code>/manager wake</code>.",
          message.message_id,
        );
        return true;
      }
    }

    const overviewUrl = overviewThreadId > 0
      ? forumTopicUrl(chatId, overviewThreadId)
      : null;
    const managerUrl = manager
      ? forumTopicUrl(chatId, manager.message_thread_id)
      : null;
    const buttons = [
      ...(overviewUrl
        ? [{
            text: `Open ${profile.overview.name}`.slice(0, 64),
            url: overviewUrl,
          }]
        : []),
      ...(managerUrl
        ? [{
            text: `Open ${profile.manager.name}`.slice(0, 64),
            url: managerUrl,
          }]
        : []),
    ];
    await tgSend(
      this.dependencies.env,
      chatId,
      `✓ <b>${escapeTelegramHtml(profile.overview.name)} is ready${
        overviewThreadId === 0 ? " in General" : ""
      }.</b>\n` +
        `${escapeTelegramHtml(profile.manager.name)} is ready in its own topic.\n\n` +
        "Create a new topic for your first task. Its setup card will open " +
        "automatically—no command is needed.",
      message.message_id,
      buttons.length > 0
        ? {
            inline_keyboard: [buttons],
          }
        : undefined,
    );
    return true;
  }
}

function telegramThreadId(
  message: Pick<TelegramMessage, "message_thread_id">,
): number {
  return Number.isSafeInteger(message.message_thread_id) &&
      message.message_thread_id! > 0
    ? message.message_thread_id!
    : 0;
}
