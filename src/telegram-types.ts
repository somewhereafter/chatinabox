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
  chat: {
    id: number;
    type?: "private" | "group" | "supergroup" | "channel";
    title?: string;
  };
  message_thread_id?: number;
  is_topic_message?: boolean;
  from?: {
    id: number;
    is_bot?: boolean;
    first_name?: string;
    username?: string;
  };
  text?: string;
  caption?: string;
  media_group_id?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  voice?: TelegramVoice;
  audio?: TelegramAudio;
  reply_to_message?: TelegramMessage;
  forum_topic_created?: {
    name: string;
    icon_color: number;
    icon_custom_emoji_id?: string;
  };
  forum_topic_edited?: {
    name?: string;
    icon_custom_emoji_id?: string;
  };
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

export interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramAudio extends TelegramVoice {
  file_name?: string;
  title?: string;
  performer?: string;
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
    "message_id" | "message_thread_id" | "chat" | "caption" | "photo"
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
