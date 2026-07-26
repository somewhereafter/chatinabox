const COMMAND_PATTERN = /^\/([A-Za-z][A-Za-z0-9_]{0,31})(?:@([A-Za-z0-9_]{5,32}))?(?:\s+([\s\S]*))?$/u;

export interface TelegramCommand {
  readonly name: string;
  readonly botUsername?: string;
  readonly argument: string;
}

/** Parse one Telegram slash command without accepting lookalike prefixes. */
export function parseTelegramCommand(text: unknown): TelegramCommand | null {
  if (
    typeof text !== "string" ||
    text.length > 4_096 ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)
  ) return null;
  const normalized = text.normalize("NFC").trim();
  const match = COMMAND_PATTERN.exec(normalized);
  if (!match) return null;
  const argument = (match[3] ?? "")
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return {
    name: match[1].toLowerCase(),
    ...(match[2] && { botUsername: match[2] }),
    argument,
  };
}
