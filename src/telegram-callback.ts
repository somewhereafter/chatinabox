export const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;
export const MAX_CALLBACK_PAYLOAD_BYTES = 8 * 1024;
export const DEFAULT_CALLBACK_TTL_MS = 15 * 60 * 1000;
export const MAX_CALLBACK_TTL_MS = 24 * 60 * 60 * 1000;

const CALLBACK_DATA_PREFIX = "c1:";
const CALLBACK_REFERENCE_BYTES = 12;
const CALLBACK_REFERENCE_PATTERN = /^[A-Za-z0-9_-]{16}$/;

export const CALLBACK_ACTIONS = [
  "codex.attach",
  "codex.detach",
  "codex.new",
  "codex.resume",
  "codex.refresh",
  "codex.interrupt",
  "codex.screen",
  "codex.key",
] as const;

export type CallbackAction = (typeof CALLBACK_ACTIONS)[number];

declare const ISSUED_CALLBACK_DATA_BRAND: unique symbol;

/** An opaque callback reference produced and validated by this module. */
export type IssuedCallbackData = string & {
  readonly [ISSUED_CALLBACK_DATA_BRAND]: true;
};

export interface PersistedCallbackReference<TPayload = unknown> {
  version: 1;
  reference: string;
  action: CallbackAction;
  chatId: number;
  userId: number;
  createdAt: number;
  expiresAt: number;
  payload: TPayload;
}

export interface CallbackReferenceStore {
  /** Persist a reference with adapter-enforced expiry for abandoned buttons. */
  put(
    record: PersistedCallbackReference<unknown>,
    ttlSeconds: number,
  ): Promise<void>;
  get(reference: string): Promise<PersistedCallbackReference<unknown> | null>;
  delete(reference: string): Promise<void>;
}

export interface IssueCallbackReferenceInput<TPayload> {
  action: CallbackAction | string;
  chatId: number;
  userId: number;
  payload: TPayload;
  ttlMs?: number;
  now?: number;
}

export interface IssuedCallbackReference<TPayload> {
  callbackData: IssuedCallbackData;
  record: PersistedCallbackReference<TPayload>;
}

export type CallbackFailureReason =
  | "TOO_LONG"
  | "MALFORMED"
  | "NOT_FOUND"
  | "EXPIRED"
  | "CHAT_MISMATCH"
  | "USER_MISMATCH"
  | "ACTION_NOT_ALLOWED"
  | "INVALID_RECORD"
  | "STORE_UNAVAILABLE";

export interface ParsedCallbackReference<TPayload = unknown> {
  version: 1;
  reference: string;
  action: CallbackAction;
  chatId: number;
  userId: number;
  createdAt: number;
  expiresAt: number;
  payload: TPayload;
}

export type CallbackParseResult<TPayload = unknown> =
  | { ok: true; value: ParsedCallbackReference<TPayload> }
  | {
      ok: false;
      reason: CallbackFailureReason;
      message: string;
    };

export interface ParseCallbackContext {
  chatId: number;
  userId: number;
  now?: number;
}

export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data: IssuedCallbackData;
}

export interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}

export interface InlineKeyboardButtonInput {
  label: string;
  callbackData: IssuedCallbackData;
}

const FAILURE_MESSAGES: Record<CallbackFailureReason, string> = {
  TOO_LONG: "This button is invalid.",
  MALFORMED: "This button is invalid.",
  NOT_FOUND: "This menu expired. Send /codex to open a fresh one.",
  EXPIRED: "This menu expired. Send /codex to open a fresh one.",
  CHAT_MISMATCH: "This button belongs to another chat.",
  USER_MISMATCH: "This button belongs to another user.",
  ACTION_NOT_ALLOWED: "This action is not available.",
  INVALID_RECORD: "This button is invalid.",
  STORE_UNAVAILABLE: "This action is temporarily unavailable.",
};

export function isCallbackAction(value: unknown): value is CallbackAction {
  return (
    typeof value === "string" &&
    (CALLBACK_ACTIONS as readonly string[]).includes(value)
  );
}

export function callbackDataByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function buildInlineKeyboard(
  rows: readonly (readonly InlineKeyboardButtonInput[])[],
): TelegramInlineKeyboardMarkup {
  if (rows.length === 0 || rows.some((row) => row.length === 0)) {
    throw new Error("Inline keyboard rows must not be empty");
  }

  return {
    inline_keyboard: rows.map((row) =>
      row.map(({ label, callbackData }) => ({
        text: normalizeButtonLabel(label),
        callback_data: assertIssuedCallbackData(callbackData),
      })),
    ),
  };
}

export async function issueCallbackReference<TPayload>(
  store: CallbackReferenceStore,
  input: IssueCallbackReferenceInput<TPayload>,
): Promise<IssuedCallbackReference<TPayload>> {
  if (!isCallbackAction(input.action)) {
    throw new Error(`Callback action is not allowlisted: ${input.action}`);
  }
  assertTelegramIdentity(input.chatId, "chatId", false);
  assertTelegramIdentity(input.userId, "userId", true);

  const now = input.now ?? Date.now();
  const ttlMs = input.ttlMs ?? DEFAULT_CALLBACK_TTL_MS;
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("Callback issue time must be a non-negative integer");
  }
  if (
    !Number.isSafeInteger(ttlMs) ||
    ttlMs <= 0 ||
    ttlMs > MAX_CALLBACK_TTL_MS
  ) {
    throw new Error(
      `Callback ttlMs must be between 1 and ${MAX_CALLBACK_TTL_MS}`,
    );
  }

  assertPersistablePayload(input.payload);

  const reference = createOpaqueReference();
  const callbackData = assertIssuedCallbackData(
    `${CALLBACK_DATA_PREFIX}${reference}`,
  );
  const record: PersistedCallbackReference<TPayload> = {
    version: 1,
    reference,
    action: input.action,
    chatId: input.chatId,
    userId: input.userId,
    createdAt: now,
    expiresAt: now + ttlMs,
    payload: input.payload,
  };

  await store.put(
    record as PersistedCallbackReference<unknown>,
    Math.ceil(ttlMs / 1000),
  );
  return { callbackData, record };
}

export async function parseCallbackReference<TPayload = unknown>(
  store: CallbackReferenceStore,
  callbackData: string,
  context: ParseCallbackContext,
): Promise<CallbackParseResult<TPayload>> {
  if (callbackDataByteLength(callbackData) > TELEGRAM_CALLBACK_DATA_MAX_BYTES) {
    return failure("TOO_LONG");
  }

  const reference = decodeCallbackData(callbackData);
  if (!reference) return failure("MALFORMED");

  let record: PersistedCallbackReference<unknown> | null;
  try {
    record = await store.get(reference);
  } catch {
    return failure("STORE_UNAVAILABLE");
  }
  if (!record) return failure("NOT_FOUND");

  if (!isCallbackAction(record.action)) {
    return failure("ACTION_NOT_ALLOWED");
  }
  if (!isValidRecord(record, reference)) {
    return failure("INVALID_RECORD");
  }

  const now = context.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    return failure("INVALID_RECORD");
  }
  if (record.expiresAt <= now) {
    try {
      await store.delete(reference);
    } catch {
      // Expiry still fails closed even if best-effort cleanup is unavailable.
    }
    return failure("EXPIRED");
  }
  if (record.chatId !== context.chatId) return failure("CHAT_MISMATCH");
  if (record.userId !== context.userId) return failure("USER_MISMATCH");

  return {
    ok: true,
    value: record as ParsedCallbackReference<TPayload>,
  };
}

function createOpaqueReference(): string {
  const bytes = crypto.getRandomValues(
    new Uint8Array(CALLBACK_REFERENCE_BYTES),
  );
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeCallbackData(callbackData: string): string | null {
  if (!callbackData.startsWith(CALLBACK_DATA_PREFIX)) return null;
  const reference = callbackData.slice(CALLBACK_DATA_PREFIX.length);
  return CALLBACK_REFERENCE_PATTERN.test(reference) ? reference : null;
}

function assertIssuedCallbackData(callbackData: string): IssuedCallbackData {
  const bytes = callbackDataByteLength(callbackData);
  if (bytes === 0 || bytes > TELEGRAM_CALLBACK_DATA_MAX_BYTES) {
    throw new Error(
      `Telegram callback_data must be 1-${TELEGRAM_CALLBACK_DATA_MAX_BYTES} bytes; received ${bytes}`,
    );
  }
  if (!decodeCallbackData(callbackData)) {
    throw new Error("Telegram callback_data must be an issued opaque reference");
  }
  return callbackData as IssuedCallbackData;
}

function assertPersistablePayload(payload: unknown): void {
  const seen = new WeakSet<object>();

  const visit = (value: unknown, path: string): void => {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      return;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new Error(`${path} must contain only JSON-safe values`);
      }
      return;
    }
    if (typeof value !== "object") {
      throw new Error(`${path} must contain only JSON-safe values`);
    }
    if (seen.has(value)) {
      throw new Error(`${path} must not contain circular references`);
    }
    seen.add(value);

    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) {
        throw new Error(`${path} must not contain sparse arrays or extra properties`);
      }
      for (let index = 0; index < value.length; index += 1) {
        visit(value[index], `${path}[${index}]`);
      }
      seen.delete(value);
      return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${path} must contain only plain JSON objects`);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      throw new Error(`${path} must not contain symbol properties`);
    }
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || descriptor.get || descriptor.set) {
        throw new Error(`${path}.${key} must be an enumerable data property`);
      }
      visit(descriptor.value, `${path}.${key}`);
    }
    seen.delete(value);
  };

  try {
    visit(payload, "Callback payload");
    const serialized = JSON.stringify(payload);
    if (serialized === undefined) {
      throw new Error("Callback payload must be JSON-serializable");
    }
    const bytes = new TextEncoder().encode(serialized).byteLength;
    if (bytes > MAX_CALLBACK_PAYLOAD_BYTES) {
      throw new Error(
        `Callback payload must not exceed ${MAX_CALLBACK_PAYLOAD_BYTES} bytes; received ${bytes}`,
      );
    }
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error("Callback payload must be JSON-serializable");
  }
}

function normalizeButtonLabel(label: string): string {
  const normalized = label
    .normalize("NFC")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) throw new Error("Inline keyboard label must not be empty");
  return normalized;
}

function assertTelegramIdentity(
  value: number,
  name: string,
  positiveOnly: boolean,
): void {
  if (
    !Number.isSafeInteger(value) ||
    value === 0 ||
    (positiveOnly && value < 0)
  ) {
    throw new Error(`${name} must be a valid Telegram identifier`);
  }
}

function isValidRecord(
  record: PersistedCallbackReference<unknown>,
  expectedReference: string,
): boolean {
  return (
    record.version === 1 &&
    record.reference === expectedReference &&
    CALLBACK_REFERENCE_PATTERN.test(record.reference) &&
    Number.isSafeInteger(record.chatId) &&
    record.chatId !== 0 &&
    Number.isSafeInteger(record.userId) &&
    record.userId > 0 &&
    Number.isSafeInteger(record.createdAt) &&
    record.createdAt >= 0 &&
    Number.isSafeInteger(record.expiresAt) &&
    record.expiresAt > record.createdAt
  );
}

function failure(reason: CallbackFailureReason): CallbackParseResult<never> {
  return { ok: false, reason, message: FAILURE_MESSAGES[reason] };
}
