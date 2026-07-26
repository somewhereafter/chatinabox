import type {
  BotEnv,
  TelegramFile,
  TelegramResponse,
} from "./telegram-types";
import type { TelegramInlineKeyboardMarkup } from "./telegram-callback";

const API = "https://api.telegram.org";

async function tgCall<T>(
  env: BotEnv,
  method: string,
  body: Record<string, unknown>,
): Promise<TelegramResponse<T>> {
  const resp = await fetch(`${API}/bot${env.TG_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await resp.json()) as TelegramResponse<T>;
  if (!data.ok) {
    // "message is not modified" is a benign no-op from progress-polling edits.
    const desc = data.description ?? "";
    if (!/not modified/i.test(desc)) {
      console.error(
        `[Telegram] ${method} failed (code=${data.error_code ?? "unknown"})`,
      );
    }
  }
  return data;
}

/** Send a text message. Returns the sent Message. */
export async function tgSend(
  env: BotEnv,
  chatId: number,
  text: string,
  replyToMsgId?: number,
  replyMarkup?: TelegramInlineKeyboardMarkup,
) {
  return tgCall<{ message_id: number }>(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...(replyToMsgId && { reply_to_message_id: replyToMsgId }),
    ...(replyMarkup && { reply_markup: replyMarkup }),
  });
}

/** Send a Telegram Rich Message from Markdown (Bot API 10.1+). */
export async function tgSendRichMarkdown(
  env: BotEnv,
  chatId: number,
  markdown: string,
  replyToMsgId?: number,
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
): Promise<Response> {
  const fd = new FormData();
  fd.set("chat_id", String(chatId));
  fd.set("document", blob, filename);
  fd.set("disable_notification", "true");
  if (caption) {
    fd.set("caption", caption);
    fd.set("parse_mode", "HTML");
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
): Promise<TelegramResponse<{ message_id: number }>> {
  const fd = new FormData();
  fd.set("chat_id", String(chatId));
  fd.set("photo", photo, "codex-terminal.png");
  if (caption) {
    fd.set("caption", caption);
    fd.set("parse_mode", "HTML");
  }
  if (replyMarkup) fd.set("reply_markup", JSON.stringify(replyMarkup));
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
