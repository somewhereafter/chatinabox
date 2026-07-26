import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  PRIVATE_BOT_RESPONSE,
  isTelegramUserAllowed,
} from "../security";
import { tgAnswerCallbackQuery, tgSend } from "../telegram";
import { parseTelegramCommand } from "../telegram-command";
import type { TelegramMessage, TelegramUpdate } from "../telegram-types";
import { codexHelpText, CodexTelegramController } from "./codex-telegram";
import { loadChatinaboxEnv, type ChatinaboxEnv } from "./env";
import { runPoller } from "./poller";
import { ChatinaboxStore } from "./store";

interface App {
  readonly env: ChatinaboxEnv;
  readonly store: ChatinaboxStore;
  readonly codex: CodexTelegramController;
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
]);

export async function handleUpdate(app: App, update: TelegramUpdate) {
  if (
    !Number.isSafeInteger(update?.update_id) ||
    update.update_id < 0 ||
    !app.store.claimTelegramUpdate(update.update_id)
  ) return;

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
    await app.codex.handleCallback(callback);
    return;
  }

  const message = update.message;
  if (!message) return;
  const ownerId = message.from?.id;
  if (
    !Number.isSafeInteger(message.chat.id) ||
    !Number.isSafeInteger(ownerId) ||
    !isTelegramUserAllowed(app.env.TG_ALLOWED_USER_IDS, ownerId!)
  ) {
    if (Number.isSafeInteger(message.chat.id)) {
      await tgSend(app.env, message.chat.id, PRIVATE_BOT_RESPONSE)
        .catch(() => undefined);
    }
    return;
  }

  if (message.photo?.length || message.document) {
    if (!app.codex.isAttached(message.chat.id, ownerId!)) {
      await app.codex.ensureLobbyAttached(message.chat.id, ownerId!);
    }
    await app.codex.routeAttachedMedia(message);
    return;
  }
  if (message.text === undefined) return;

  const command = parseTelegramCommand(message.text);
  if (command?.name === "start") {
    await welcome(app, message);
    return;
  }
  if (command?.name === "help") {
    await tgSend(app.env, message.chat.id, codexHelpText(), message.message_id);
    return;
  }
  if (command && await app.codex.handleCommand(message, command)) return;

  // Unknown slash commands are Codex commands. Ordinary detached messages
  // wake the lobby automatically, so the bot always feels like an intelligence.
  if (
    command === null ||
    !LOCAL_COMMANDS.has(command.name)
  ) {
    if (!app.codex.isAttached(message.chat.id, ownerId!)) {
      const attached = await app.codex.ensureLobbyAttached(
        message.chat.id,
        ownerId!,
      );
      if (!attached) {
        await tgSend(
          app.env,
          message.chat.id,
          "⚠️ The Codex bridge is not ready yet. Try /codex in a moment.",
          message.message_id,
        );
        return;
      }
    }
    await app.codex.routeAttachedMessage(message);
  }
}

async function welcome(app: App, message: TelegramMessage): Promise<void> {
  await tgSend(
    app.env,
    message.chat.id,
    "🪄 <b>Chatinabox is awake.</b>\n\n" +
      "Just talk: detached messages wake the Lobby automatically. " +
      "Use <code>/codex</code> to discover, start, resume, rename, or switch " +
      "sessions; <code>/screen</code> to see and control the terminal; " +
      "<code>/help</code> for every command.",
    message.message_id,
  );
  await app.codex.handleCommand(message, { name: "codex", argument: "" });
}

async function main(): Promise<void> {
  const env = loadChatinaboxEnv();
  mkdirSync(env.DATA_DIR, { recursive: true, mode: 0o700 });
  const store = new ChatinaboxStore(path.join(env.DATA_DIR, "chatinabox.sqlite"));
  const codex = new CodexTelegramController({ env, store });
  const app: App = { env, store, codex };
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("shutting down"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  console.log("[Chatinabox] Telegram listener ready.");
  try {
    await Promise.all([
      runPoller(env, store, (update) => handleUpdate(app, update), controller.signal),
      codex.run(controller.signal),
    ]);
  } finally {
    store.close();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      `[Chatinabox] Fatal: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  });
}
