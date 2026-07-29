import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  PRIVATE_BOT_RESPONSE,
  isTelegramUserAllowed,
} from "../security";
import {
  escapeTelegramHtml,
  tgAnswerCallbackQuery,
  tgSend,
} from "../telegram";
import { parseTelegramCommand } from "../telegram-command";
import type { TelegramMessage, TelegramUpdate } from "../telegram-types";
import {
  codexHelpText,
  CodexTelegramController,
  telegramMessageThreadId,
} from "./codex-telegram";
import { loadChatinaboxEnv, type ChatinaboxEnv } from "./env";
import {
  ExperienceProfileProvider,
  type ExperienceProfile,
} from "./experience-profile";
import { OverviewController } from "./overview";
import { runPoller } from "./poller";
import { ChatinaboxStore } from "./store";
import { TopicSessionController } from "./topic-sessions";
import { ManagerController } from "./manager";
import { TelegramProgressPacer } from "./progress-pacer";
import { ForumSetupController } from "./forum-setup";
import {
  controlTopicRole,
  controlTopicSetupBlockedText,
} from "./control-topics";
import { ScheduleController } from "./schedules";

interface App {
  readonly env: ChatinaboxEnv;
  readonly store: ChatinaboxStore;
  readonly codex: CodexTelegramController;
  readonly overview: OverviewController;
  readonly topics: TopicSessionController;
  readonly manager: ManagerController;
  readonly forum: ForumSetupController;
  readonly profile: () => ExperienceProfile;
}

const LOCAL_COMMANDS = new Set([
  "start",
  "help",
  "codex",
  "codex_sessions",
  "attach",
  "codex_attach",
  "detach",
  "unattach",
  "codex_detach",
  "codex_new",
  "codex_rename",
  "codex_interrupt",
  "screen",
  "codex_screen",
  "key",
  "codex_key",
  "codex_help",
  "nexus",
  "overview",
  "forum",
  "setup",
  "wizard",
  "manager",
  "settings",
]);

export async function handleUpdate(app: App, update: TelegramUpdate) {
  if (
    !Number.isSafeInteger(update?.update_id) ||
    update.update_id < 0 ||
    !app.store.claimTelegramUpdate(update.update_id)
  ) return;
  try {
    await handleClaimedUpdate(app, update);
    app.store.completeTelegramUpdate(update.update_id);
  } catch (error) {
    app.store.releaseTelegramUpdate(update.update_id);
    throw error;
  }
}

async function handleClaimedUpdate(app: App, update: TelegramUpdate) {
  const callback = update.callback_query;
  if (callback) {
    const ownerId = callback.from?.id;
    if (!isTelegramUserAllowed(app.env.TG_ALLOWED_USER_IDS, ownerId)) {
      await tgAnswerCallbackQuery(app.env, callback.id, {
        text: PRIVATE_BOT_RESPONSE,
        showAlert: true,
        cacheTime: 0,
      }).catch(() => undefined);
      return;
    }
    if (await app.overview.handleCallback(callback)) return;
    if (await app.topics.handleCallback(callback)) return;
    await app.codex.handleCallback(callback);
    return;
  }

  const message = update.message;
  if (!message) return;
  const ownerId = message.from?.id;
  const managedGroup =
    Number.isSafeInteger(message.chat.id) &&
    (
      app.overview.isOverviewChat(message.chat.id) ||
      app.manager.isManagerChat(message.chat.id)
    );
  if (
    !Number.isSafeInteger(message.chat.id) ||
    !Number.isSafeInteger(ownerId) ||
    !isTelegramUserAllowed(app.env.TG_ALLOWED_USER_IDS, ownerId!)
  ) {
    if (managedGroup) return;
    if (Number.isSafeInteger(message.chat.id)) {
      await tgSend(app.env, message.chat.id, PRIVATE_BOT_RESPONSE)
        .catch(() => undefined);
    }
    return;
  }

  const command =
    message.text === undefined ? null : parseTelegramCommand(message.text);
  if (command?.name === "forum") {
    await app.forum.handleCommand(message, command);
    return;
  }
  if (command?.name === "setup") {
    const threadId = telegramMessageThreadId(message);
    const role = controlTopicRole(app.store, message.chat.id, threadId);
    if (role) {
      await tgSend(
        app.env,
        message.chat.id,
        controlTopicSetupBlockedText(role),
        message.message_id,
        undefined,
        threadId || undefined,
      );
      return;
    }
  }
  if (await app.topics.handleMessage(message, command)) return;
  if (command?.name === "nexus" || command?.name === "overview") {
    await app.overview.handleCommand(message, command);
    return;
  }
  if (command?.name === "wizard" || command?.name === "manager") {
    await app.manager.handleCommand(message, command);
    return;
  }
  // Overview and manager are isolated forum topics. Other group topics are inert.
  if (app.overview.isOverviewMessage(message)) return;
  const managerMessage = app.manager.isManagerMessage(message);
  const topicAttachment = app.store.codexAttachment(
    message.chat.id,
    ownerId!,
    telegramMessageThreadId(message),
  );
  if (managedGroup && !managerMessage && !topicAttachment) return;
  if (managerMessage && !await app.manager.ensureAttached(message)) {
    const manager = app.profile().manager;
    await tgSend(
      app.env,
      message.chat.id,
      `⚠️ ${escapeTelegramHtml(manager.name)} could not reconnect. ` +
        "Send <code>/manager wake</code>.",
      message.message_id,
    );
    return;
  }

  if (message.voice || message.audio) {
    if (
      !app.codex.isAttached(
        message.chat.id,
        ownerId!,
        telegramMessageThreadId(message),
      )
    ) {
      const attached = await app.codex.ensureLobbyAttached(
        message.chat.id,
        ownerId!,
        telegramMessageThreadId(message),
      );
      if (!attached) {
        await tgSend(
          app.env,
          message.chat.id,
          "⚠️ The session bridge is still starting. Your voice note was not sent; try again in a moment.",
          message.message_id,
        );
        return;
      }
    }
    const routed = await app.codex.routeAttachedVoice(message);
    if (!routed) {
      await tgSend(
        app.env,
        message.chat.id,
        "⚠️ That voice note could not be routed to the current session.",
        message.message_id,
      );
    }
    return;
  }
  if (message.photo?.length || message.document) {
    if (
      !app.codex.isAttached(
        message.chat.id,
        ownerId!,
        telegramMessageThreadId(message),
      )
    ) {
      const attached = await app.codex.ensureLobbyAttached(
        message.chat.id,
        ownerId!,
        telegramMessageThreadId(message),
      );
      if (!attached) {
        await tgSend(
          app.env,
          message.chat.id,
          "⚠️ The session bridge is still starting. Your attachment was not sent; try again in a moment.",
          message.message_id,
        );
        return;
      }
    }
    const routed = await app.codex.routeAttachedMedia(message);
    if (!routed) {
      await tgSend(
        app.env,
        message.chat.id,
        "⚠️ That attachment could not be routed to the current session.",
        message.message_id,
      );
    }
    return;
  }
  if (message.text === undefined) return;

  if (command?.name === "start" || command?.name === "settings") {
    await welcome(app, message, command.name === "settings");
    return;
  }
  if (command?.name === "help") {
    await tgSend(
      app.env,
      message.chat.id,
      codexHelpText(app.profile()),
      message.message_id,
    );
    return;
  }
  if (command && await app.codex.handleCommand(message, command)) return;

  // Unknown slash commands are Codex commands. Ordinary detached messages
  // wake the lobby automatically, so the bot always feels like an intelligence.
  if (
    command === null ||
    !LOCAL_COMMANDS.has(command.name)
  ) {
    if (
      !app.codex.isAttached(
        message.chat.id,
        ownerId!,
        telegramMessageThreadId(message),
      )
    ) {
      const attached = await app.codex.ensureLobbyAttached(
        message.chat.id,
        ownerId!,
        telegramMessageThreadId(message),
      );
      if (!attached) {
        await tgSend(
          app.env,
          message.chat.id,
          "⚠️ The session bridge is still starting. Try <code>/codex</code> in a moment.",
          message.message_id,
        );
        return;
      }
    }
    await app.codex.routeAttachedMessage(message);
  }
}

async function welcome(
  app: App,
  message: TelegramMessage,
  revisitSettings = false,
): Promise<void> {
  const profile = app.profile();
  if (!profile.setupComplete || revisitSettings) {
    if (message.chat.id < 0) {
      await tgSend(
        app.env,
        message.chat.id,
        "⌁ Open the bot’s private chat and send " +
          `<code>/${revisitSettings ? "settings" : "start"}</code> there. ` +
          "Experience setup is kept outside worker topics.",
        message.message_id,
      );
      return;
    }
    const attached = await app.codex.ensureLobbyAttached(
      message.chat.id,
      message.from!.id,
      telegramMessageThreadId(message),
      true,
    );
    await tgSend(
      app.env,
      message.chat.id,
      (
        revisitSettings && profile.setupComplete
          ? formatSettingsWelcome(profile)
          : formatFirstRunWelcome()
      ) +
        (!attached
          ? "\n\n⚠️ The local session bridge is still starting. Send " +
            "<code>/start</code> again in a moment."
          : ""),
      message.message_id,
    );
    return;
  }
  await tgSend(
    app.env,
    message.chat.id,
    "🪄 <b>Chatinabox</b>\n" +
      "Your Codex sessions, through Telegram.\n\n" +
      "Talk normally—the Lobby wakes automatically when nothing is attached. " +
      "Use <code>/codex</code> to switch sessions, <code>/screen</code> for " +
      "the terminal, and <code>/help</code> for every control.",
    message.message_id,
  );
  await app.codex.handleCommand(message, { name: "codex", argument: "" });
}

export function formatSettingsWelcome(profile: ExperienceProfile): string {
  return (
    "⌁ <b>Experience settings</b>\n\n" +
    `Current voice · ${escapeTelegramHtml(profile.assistant.name)}\n` +
    `Dashboard · ${escapeTelegramHtml(profile.overview.name)}\n` +
    `Manager · ${escapeTelegramHtml(profile.manager.name)} · ` +
    `${escapeTelegramHtml(profile.manager.role)}\n\n` +
    "Tell the guide what you want to change. Plain language is enough; it will " +
    "show you the result before treating the setup as settled.\n\n" +
    "<footer>the private profile is preserved across upgrades</footer>"
  );
}

async function main(): Promise<void> {
  const env = loadChatinaboxEnv();
  const profileProvider = new ExperienceProfileProvider(
    env.PROFILE_PATH ?? "/etc/chatinabox/profile.json",
  );
  const profile = () => profileProvider.current();
  mkdirSync(env.DATA_DIR, { recursive: true, mode: 0o700 });
  const store = new ChatinaboxStore(path.join(env.DATA_DIR, "chatinabox.sqlite"));
  const progressPacer = new TelegramProgressPacer();
  const topics = new TopicSessionController({ env, store, profile });
  const codex = new CodexTelegramController({
    env,
    store,
    profile,
    progressPacer,
    topicPresence: topics,
  });
  const schedules = new ScheduleController({
    env,
    store,
    dispatchTask: async (occurrence) => {
      let attachment = await topics.ensureTopicAwake(
        occurrence.schedule.chat_id,
        occurrence.schedule.owner_user_id,
        occurrence.schedule.message_thread_id,
      );
      if (!attachment && occurrence.schedule.message_thread_id === 0) {
        const attached = await codex.ensureLobbyAttached(
          occurrence.schedule.chat_id,
          occurrence.schedule.owner_user_id,
          0,
        );
        if (attached) {
          attachment = store.codexAttachment(
            occurrence.schedule.chat_id,
            occurrence.schedule.owner_user_id,
            0,
          );
        }
      }
      if (!attachment) {
        return {
          ok: false as const,
          error: "The target topic could not resume its Codex session.",
        };
      }
      return codex.routeScheduledTask({
        chatId: occurrence.schedule.chat_id,
        ownerUserId: occurrence.schedule.owner_user_id,
        messageThreadId: occurrence.schedule.message_thread_id,
        occurrenceId: occurrence.id,
        scheduleId: occurrence.schedule.id,
        name: occurrence.schedule.name,
        prompt: occurrence.schedule.payload,
      });
    },
  });
  const overview = new OverviewController({
    env,
    store,
    profile,
    progressPacer,
  });
  const manager = new ManagerController({ env, store, profile });
  const forum = new ForumSetupController({
    env,
    store,
    overview,
    manager,
    profile,
  });
  const app: App = {
    env,
    store,
    codex,
    overview,
    topics,
    manager,
    forum,
    profile,
  };
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("shutting down"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  console.log("[Chatinabox] Telegram listener ready.");
  try {
    await Promise.all([
      runPoller(env, store, (update) => handleUpdate(app, update), controller.signal),
      codex.run(controller.signal),
      schedules.run(controller.signal),
      overview.run(controller.signal),
      topics.run(controller.signal),
    ]);
  } finally {
    store.close();
  }
}

export function formatFirstRunWelcome(): string {
  return (
    "⌁ <b>Welcome to Chatinabox</b>\n\n" +
    "This first conversation is setup. Talk to the guide normally—describe " +
    "how you want the bot to feel, or simply say " +
    "<i>keep it simple</i>. It can co-design the bot name and photo, forum " +
    "name and photo, manager identity, model defaults, and idle " +
    "policy with you.\n\n" +
    "The guide will show you a compact preview, then shape a private profile " +
    "without changing the source. " +
    "It will then walk you through creating a Telegram forum. Once the bot is " +
    "an administrator, one <code>/forum setup</code> command in General " +
    "prepares the Overview and Manager for you.\n\n" +
    "<blockquote>When the forum is ready, pin the 🔮 manager/orchestrator " +
    "topic so it stays easy to reach. General holds the overview/dashboard." +
    "</blockquote>\n\n" +
    "<footer>you can return here later with /settings</footer>"
  );
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      `[Chatinabox] Fatal: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  });
}
