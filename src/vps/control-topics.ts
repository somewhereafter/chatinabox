import type { TelegramInlineKeyboardMarkup } from "../telegram-callback";
import {
  escapeTelegramHtml,
  tgEditRichHtml,
  tgSend,
} from "../telegram";
import type { ChatinaboxEnv } from "./env";
import type { ChatinaboxStore } from "./store";

export type ControlTopicRole = "overview" | "manager";

export function controlTopicRole(
  store: ChatinaboxStore,
  chatId: number,
  messageThreadId: number,
): ControlTopicRole | null {
  if (store.overviewDashboard(chatId)?.message_thread_id === messageThreadId) {
    return "overview";
  }
  if (store.managerTopic(chatId)?.message_thread_id === messageThreadId) {
    return "manager";
  }
  return null;
}

export async function retireWorkTopicSetup(
  env: ChatinaboxEnv,
  store: ChatinaboxStore,
  chatId: number,
  ownerUserId: number,
  messageThreadId: number,
  role: ControlTopicRole,
  options: { readonly detach?: boolean } = {},
): Promise<void> {
  if (options.detach !== false) {
    store.detachCodex(chatId, ownerUserId, messageThreadId);
  }
  if (messageThreadId <= 0) return;
  const setup = store.topicSetup(chatId, ownerUserId, messageThreadId);
  store.deleteTopicSetup(chatId, ownerUserId, messageThreadId);
  if (!setup?.starter_message_id) return;
  const label = role === "overview" ? "Overview" : "Manager";
  await tgEditRichHtml(
    env,
    chatId,
    setup.starter_message_id,
    `✓ <b>${label} topic</b>\nThis topic is reserved for Chatinabox control.`,
    emptyKeyboard(),
  ).catch(() => undefined);
}

export async function sendControlTopicConflict(
  env: ChatinaboxEnv,
  chatId: number,
  replyToMessageId: number,
  messageThreadId: number,
  role: ControlTopicRole,
  existingThreadId: number,
): Promise<void> {
  const label = role === "overview" ? "Overview" : "Manager";
  const url = forumTopicUrl(chatId, existingThreadId);
  await tgSend(
    env,
    chatId,
    `↗ <b>${label} is already set up.</b>\nOpen the existing topic instead of moving it.`,
    replyToMessageId,
    url
      ? {
          inline_keyboard: [[{
            text: `Open ${label}`,
            url,
          }]],
        }
      : undefined,
    messageThreadId || undefined,
  );
}

export function forumTopicUrl(
  chatId: number,
  messageThreadId: number,
): string | null {
  const match = String(chatId).match(/^-100(\d+)$/u);
  return match && messageThreadId > 0
    ? `https://t.me/c/${match[1]}/${messageThreadId}`
    : null;
}

export function controlTopicSetupBlockedText(role: ControlTopicRole): string {
  const label = role === "overview" ? "Overview" : "Manager";
  return (
    `○ <b>${escapeTelegramHtml(label)} is a control topic.</b>\n` +
    "Create a new forum topic for normal Codex work."
  );
}

function emptyKeyboard(): TelegramInlineKeyboardMarkup {
  return { inline_keyboard: [] };
}
