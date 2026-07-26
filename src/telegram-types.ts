/** Minimal environment surface required by the Bot API helpers. */
export interface BotEnv {
  TG_BOT_TOKEN: string;
}

// ── Telegram types (subset we need) ───────────────────────
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  from?: { id: number };
  text?: string;
  caption?: string;
  media_group_id?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  date: number;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: { id: number };
  message?: Pick<
    TelegramMessage,
    "message_id" | "chat" | "caption" | "photo"
  >;
  data?: string;
}

export interface TelegramResponse<T = unknown> {
  ok: boolean;
  result: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}
