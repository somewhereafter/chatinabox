import type {
  BotEnv,
  TelegramFile,
  TelegramResponse,
} from "./telegram-types";
import type { TelegramInlineKeyboardMarkup } from "./telegram-callback";

const API = "https://api.telegram.org";
let telegramRetryAfterUntil = 0;
const nextChatSendAt = new Map<number, number>();
const pacedChatUntil = new Map<number, number>();
const GROUP_SEND_INTERVAL_MS = 3_100;
const PRIVATE_SEND_INTERVAL_MS = 1_100;
const RATE_LIMIT_RECOVERY_MS = 5 * 60 * 1_000;
const PACED_SEND_METHODS = new Set(["sendMessage", "sendRichMessage"]);

/**
 * A second send is safe only when Telegram explicitly rejected the rich
 * request. Transport failures, 5xx responses, and 429s have ambiguous or
 * retryable outcomes and must not immediately create a legacy duplicate.
 */
export function tgCanFallbackAfterRichFailure(
  response: TelegramResponse<unknown> | null | undefined,
): boolean {
  if (!response || response.ok) return false;
  return (
    response.error_code === undefined ||
    response.error_code === 400 ||
    response.error_code === 404
  );
}

async function tgCall<T>(
  env: BotEnv,
  method: string,
  body: Record<string, unknown>,
): Promise<TelegramResponse<T>> {
  const now = Date.now();
  if (now < telegramRetryAfterUntil) {
    return {
      ok: false,
      result: undefined as T,
      description: "Telegram rate-limit backoff is active.",
      error_code: 429,
      parameters: {
        retry_after: Math.max(
          1,
          Math.ceil((telegramRetryAfterUntil - now) / 1_000),
        ),
      },
    };
  }
  const chatId = typeof body.chat_id === "number" ? body.chat_id : null;
  if (
    chatId !== null &&
    (pacedChatUntil.get(chatId) ?? 0) <= now
  ) {
    pacedChatUntil.delete(chatId);
    nextChatSendAt.delete(chatId);
  }
  if (
    chatId !== null &&
    PACED_SEND_METHODS.has(method) &&
    pacedChatUntil.has(chatId) &&
    now < (nextChatSendAt.get(chatId) ?? 0)
  ) {
    return {
      ok: false,
      result: undefined as T,
      description: "Telegram per-chat send pacing is active.",
      error_code: 429,
      parameters: {
        retry_after: Math.max(
          1,
          Math.ceil(((nextChatSendAt.get(chatId) ?? now) - now) / 1_000),
        ),
      },
    };
  }
  const resp = await fetch(`${API}/bot${env.TG_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await resp.json()) as TelegramResponse<T>;
  if (
    data.ok &&
    chatId !== null &&
    PACED_SEND_METHODS.has(method) &&
    pacedChatUntil.has(chatId)
  ) {
    nextChatSendAt.set(
      chatId,
      Date.now() + (
        chatId < 0 ? GROUP_SEND_INTERVAL_MS : PRIVATE_SEND_INTERVAL_MS
      ),
    );
  }
  if (!data.ok) {
    if (data.error_code === 429) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil(data.parameters?.retry_after ?? 1),
      );
      telegramRetryAfterUntil =
        Date.now() + retryAfterSeconds * 1_000 + 250;
      if (chatId !== null && PACED_SEND_METHODS.has(method)) {
        pacedChatUntil.set(chatId, Date.now() + RATE_LIMIT_RECOVERY_MS);
      }
      console.error(
        `[Telegram] rate limited; backing off for ${retryAfterSeconds}s.`,
      );
      return data;
    }
    // "message is not modified" is a benign no-op from progress-polling edits.
    const desc = data.description ?? "";
    if (!/not modified/i.test(desc)) {
      const diagnostic = desc
        .replace(/[\u0000-\u001f\u007f]+/gu, " ")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 300);
      console.error(
        `[Telegram] ${method} failed (code=${data.error_code ?? "unknown"})` +
          (diagnostic ? `: ${diagnostic}` : ""),
      );
    }
  }
  return data;
}

async function tgMultipartCall<T>(
  env: BotEnv,
  method: string,
  form: FormData,
): Promise<TelegramResponse<T>> {
  const response = await fetch(`${API}/bot${env.TG_BOT_TOKEN}/${method}`, {
    method: "POST",
    body: form,
  });
  const data = (await response.json()) as TelegramResponse<T>;
  if (!data.ok) {
    console.error(
      `[Telegram] ${method} failed (code=${data.error_code ?? "unknown"})`,
    );
  }
  return data;
}

/** Apply the configured display name to the Telegram bot account. */
export async function tgSetMyName(env: BotEnv, name: string) {
  return tgCall<boolean>(env, "setMyName", { name });
}

/** Apply a static JPEG as the Telegram bot account's profile photo. */
export async function tgSetMyProfilePhoto(env: BotEnv, photo: Blob) {
  const form = new FormData();
  form.set("photo", JSON.stringify({
    type: "static",
    photo: "attach://profile_photo",
  }));
  form.set("profile_photo", photo, "chatinabox-profile.jpg");
  return tgMultipartCall<boolean>(env, "setMyProfilePhoto", form);
}

/** Apply the configured title to a Telegram forum group. */
export async function tgSetChatTitle(
  env: BotEnv,
  chatId: number,
  title: string,
) {
  return tgCall<boolean>(env, "setChatTitle", {
    chat_id: chatId,
    title,
  });
}

/** Apply a static JPEG as a Telegram forum group's photo. */
export async function tgSetChatPhoto(
  env: BotEnv,
  chatId: number,
  photo: Blob,
) {
  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set("photo", photo, "chatinabox-group.jpg");
  return tgMultipartCall<boolean>(env, "setChatPhoto", form);
}

/** Send a text message. Returns the sent Message. */
export async function tgSend(
  env: BotEnv,
  chatId: number,
  text: string,
  replyToMsgId?: number,
  replyMarkup?: TelegramInlineKeyboardMarkup,
  messageThreadId?: number,
) {
  return tgCall<{ message_id: number }>(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...(replyToMsgId && { reply_to_message_id: replyToMsgId }),
    ...(replyMarkup && { reply_markup: replyMarkup }),
    ...(messageThreadId && { message_thread_id: messageThreadId }),
  });
}

/** Send a Telegram Rich Message from Markdown (Bot API 10.1+). */
export async function tgSendRichMarkdown(
  env: BotEnv,
  chatId: number,
  markdown: string,
  replyToMsgId?: number,
  messageThreadId?: number,
) {
  return tgCall<{ message_id: number }>(env, "sendRichMessage", {
    chat_id: chatId,
    rich_message: { markdown },
    ...(replyToMsgId && {
      reply_parameters: {
        message_id: replyToMsgId,
        allow_sending_without_reply: true,
      },
    }),
    ...(messageThreadId && { message_thread_id: messageThreadId }),
  });
}

/** Send a Telegram Rich Message from HTML (Bot API 10.2+). */
export async function tgSendRichHtml(
  env: BotEnv,
  chatId: number,
  html: string,
  replyToMsgId?: number,
  replyMarkup?: TelegramInlineKeyboardMarkup,
  messageThreadId?: number,
) {
  return tgCall<{ message_id: number }>(env, "sendRichMessage", {
    chat_id: chatId,
    rich_message: { html },
    ...(replyToMsgId && {
      reply_parameters: {
        message_id: replyToMsgId,
        allow_sending_without_reply: true,
      },
    }),
    ...(replyMarkup && { reply_markup: replyMarkup }),
    ...(messageThreadId && { message_thread_id: messageThreadId }),
  });
}

/** Edit an existing text message. */
export async function tgEditMessage(
  env: BotEnv,
  chatId: number,
  messageId: number,
  text: string,
  replyMarkup?: TelegramInlineKeyboardMarkup,
) {
  return tgCall(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    ...(replyMarkup && { reply_markup: replyMarkup }),
  });
}

/** Edit an existing Telegram Rich Message from HTML (Bot API 10.2+). */
export async function tgEditRichHtml(
  env: BotEnv,
  chatId: number,
  messageId: number,
  html: string,
  replyMarkup?: TelegramInlineKeyboardMarkup,
) {
  return tgCall(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    rich_message: { html },
    ...(replyMarkup && { reply_markup: replyMarkup }),
  });
}

/** Edit an existing Telegram Rich Message from Markdown (Bot API 10.2+). */
export async function tgEditRichMarkdown(
  env: BotEnv,
  chatId: number,
  messageId: number,
  markdown: string,
  replyMarkup?: TelegramInlineKeyboardMarkup,
) {
  return tgCall(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    rich_message: { markdown },
    ...(replyMarkup && { reply_markup: replyMarkup }),
  });
}

/** Edit the caption on an existing bot-sent media message. */
export async function tgEditMessageCaption(
  env: BotEnv,
  chatId: number,
  messageId: number,
  caption: string,
  replyMarkup?: TelegramInlineKeyboardMarkup,
) {
  return tgCall(env, "editMessageCaption", {
    chat_id: chatId,
    message_id: messageId,
    caption,
    parse_mode: "HTML",
    ...(replyMarkup && { reply_markup: replyMarkup }),
  });
}

export interface AnswerCallbackQueryOptions {
  text?: string;
  showAlert?: boolean;
  cacheTime?: number;
}

/** Acknowledge an inline-keyboard callback so Telegram clears its spinner. */
export async function tgAnswerCallbackQuery(
  env: BotEnv,
  callbackQueryId: string,
  options: AnswerCallbackQueryOptions = {},
) {
  if (!callbackQueryId.trim()) {
    throw new Error("callbackQueryId must not be empty");
  }

  return tgCall<boolean>(env, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(options.text !== undefined && { text: options.text }),
    ...(options.showAlert !== undefined && {
      show_alert: options.showAlert,
    }),
    ...(options.cacheTime !== undefined && { cache_time: options.cacheTime }),
  });
}

/** Escape dynamic text before inserting it into a Telegram HTML message. */
export function escapeTelegramHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Delete a message (best-effort). */
export async function tgDeleteMessage(
  env: BotEnv,
  chatId: number,
  messageId: number,
) {
  return tgCall(env, "deleteMessage", {
    chat_id: chatId,
    message_id: messageId,
  });
}

/** Rename a forum topic. */
export async function tgEditForumTopic(
  env: BotEnv,
  chatId: number,
  messageThreadId: number,
  name: string,
) {
  return tgCall<boolean>(env, "editForumTopic", {
    chat_id: chatId,
    message_thread_id: messageThreadId,
    name,
  });
}

export interface TelegramForumTopic {
  readonly message_thread_id: number;
  readonly name: string;
  readonly icon_color: number;
  readonly icon_custom_emoji_id?: string;
}

/** Create a named topic in a Telegram forum group. */
export async function tgCreateForumTopic(
  env: BotEnv,
  chatId: number,
  name: string,
) {
  return tgCall<TelegramForumTopic>(env, "createForumTopic", {
    chat_id: chatId,
    name,
  });
}

/** Change the large custom-emoji icon on a forum topic. */
export async function tgEditForumTopicIcon(
  env: BotEnv,
  chatId: number,
  messageThreadId: number,
  customEmojiId: string,
) {
  return tgCall<boolean>(env, "editForumTopic", {
    chat_id: chatId,
    message_thread_id: messageThreadId,
    icon_custom_emoji_id: customEmojiId,
  });
}

export interface TelegramForumTopicIconSticker {
  emoji?: string;
  custom_emoji_id?: string;
}

/** List the custom emoji Telegram permits as forum-topic icons. */
export async function tgGetForumTopicIconStickers(env: BotEnv) {
  return tgCall<TelegramForumTopicIconSticker[]>(
    env,
    "getForumTopicIconStickers",
    {},
  );
}

/** Pin a bot-sent message without generating a service notification. */
export async function tgPinChatMessage(
  env: BotEnv,
  chatId: number,
  messageId: number,
) {
  return tgCall<boolean>(env, "pinChatMessage", {
    chat_id: chatId,
    message_id: messageId,
    disable_notification: true,
  });
}

/** Resolve a Telegram file_id to its short-lived Bot API download path. */
export async function tgGetFile(
  env: BotEnv,
  fileId: string,
): Promise<TelegramFile> {
  const response = await tgCall<TelegramFile>(env, "getFile", {
    file_id: fileId,
  });
  if (!response.ok || !response.result?.file_path) {
    throw new Error("Telegram could not prepare that attachment.");
  }
  return response.result;
}

/**
 * Download a Telegram file with a streamed hard byte limit. The bot token is
 * deliberately kept out of thrown errors and logs.
 */
export async function tgDownloadFile(
  env: BotEnv,
  filePath: string,
  maxBytes: number,
): Promise<Buffer> {
  const safePath = normalizeTelegramFilePath(filePath);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("Attachment byte limit is invalid.");
  }
  const encodedPath = safePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const response = await fetch(
    `${API}/file/bot${env.TG_BOT_TOKEN}/${encodedPath}`,
  );
  if (!response.ok || !response.body) {
    throw new Error("Telegram attachment download failed.");
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > maxBytes
  ) {
    await response.body.cancel().catch(() => undefined);
    throw new Error("That attachment is too large.");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      received += next.value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("That attachment is too large.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), received);
}

function normalizeTelegramFilePath(value: string): string {
  const normalized = value.replace(/\\/gu, "/").trim();
  const segments = normalized.split("/");
  if (
    normalized.length === 0 ||
    normalized.length > 512 ||
    normalized.startsWith("/") ||
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        !/^[A-Za-z0-9._-]+$/u.test(segment),
    )
  ) {
    throw new Error("Telegram returned an invalid attachment path.");
  }
  return normalized;
}

/**
 * Upload a document via multipart/form-data.
 * Returns the full TG response so the caller can handle 429s.
 */
export async function tgSendDocument(
  env: BotEnv,
  chatId: number,
  blob: Blob,
  filename: string,
  caption?: string,
  messageThreadId?: number,
): Promise<Response> {
  const fd = new FormData();
  fd.set("chat_id", String(chatId));
  fd.set("document", blob, filename);
  fd.set("disable_notification", "true");
  if (caption) {
    fd.set("caption", caption);
    fd.set("parse_mode", "HTML");
  }
  if (messageThreadId) {
    fd.set("message_thread_id", String(messageThreadId));
  }

  return fetch(`${API}/bot${env.TG_BOT_TOKEN}/sendDocument`, {
    method: "POST",
    body: fd,
  });
}

/** Send an in-memory PNG as a Telegram photo with optional controls. */
export async function tgSendPhoto(
  env: BotEnv,
  chatId: number,
  photo: Blob,
  caption?: string,
  replyMarkup?: TelegramInlineKeyboardMarkup,
  messageThreadId?: number,
  replyToMessageId?: number,
): Promise<TelegramResponse<{ message_id: number }>> {
  const fd = new FormData();
  fd.set("chat_id", String(chatId));
  fd.set("photo", photo, "codex-terminal.png");
  if (caption) {
    fd.set("caption", caption);
    fd.set("parse_mode", "HTML");
  }
  if (replyMarkup) fd.set("reply_markup", JSON.stringify(replyMarkup));
  if (messageThreadId) {
    fd.set("message_thread_id", String(messageThreadId));
  }
  if (replyToMessageId) {
    fd.set("reply_parameters", JSON.stringify({
      message_id: replyToMessageId,
      allow_sending_without_reply: true,
    }));
  }
  const response = await fetch(`${API}/bot${env.TG_BOT_TOKEN}/sendPhoto`, {
    method: "POST",
    body: fd,
  });
  return (await response.json()) as TelegramResponse<{ message_id: number }>;
}

/** Replace a bot-sent photo message while preserving it as one screen card. */
export async function tgEditPhotoMedia(
  env: BotEnv,
  chatId: number,
  messageId: number,
  photo: Blob,
  caption?: string,
  replyMarkup?: TelegramInlineKeyboardMarkup,
): Promise<TelegramResponse<{ message_id: number }>> {
  const fd = new FormData();
  fd.set("chat_id", String(chatId));
  fd.set("message_id", String(messageId));
  fd.set("photo", photo, "codex-terminal.png");
  fd.set("media", JSON.stringify({
    type: "photo",
    media: "attach://photo",
    ...(caption && {
      caption,
      parse_mode: "HTML",
    }),
  }));
  if (replyMarkup) fd.set("reply_markup", JSON.stringify(replyMarkup));
  const response = await fetch(
    `${API}/bot${env.TG_BOT_TOKEN}/editMessageMedia`,
    {
      method: "POST",
      body: fd,
    },
  );
  return (await response.json()) as TelegramResponse<{ message_id: number }>;
}

/** Send an in-memory PNG without Telegram's photo recompression. */
export async function tgSendPngDocument(
  env: BotEnv,
  chatId: number,
  image: Blob,
  caption?: string,
  replyMarkup?: TelegramInlineKeyboardMarkup,
): Promise<TelegramResponse<{ message_id: number }>> {
  const fd = new FormData();
  fd.set("chat_id", String(chatId));
  fd.set("document", image, "codex-terminal.png");
  if (caption) {
    fd.set("caption", caption);
    fd.set("parse_mode", "HTML");
  }
  if (replyMarkup) fd.set("reply_markup", JSON.stringify(replyMarkup));
  const response = await fetch(`${API}/bot${env.TG_BOT_TOKEN}/sendDocument`, {
    method: "POST",
    body: fd,
  });
  return (await response.json()) as TelegramResponse<{ message_id: number }>;
}
