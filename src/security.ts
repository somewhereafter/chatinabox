export const PRIVATE_BOT_RESPONSE = "🔒 This bot is private.";

/**
 * A comma-separated list of positive Telegram user IDs. Missing or malformed
 * configuration denies all.
 */
export function isTelegramUserAllowed(
  configuredPolicy: string | undefined,
  userId: number,
): boolean {
  if (!Number.isSafeInteger(userId) || userId <= 0 || configuredPolicy === undefined) {
    return false;
  }

  const policy = configuredPolicy.trim();
  if (policy === "*") return false;
  if (policy === "") return false;

  const parts = policy.split(",");
  if (parts.length === 0) return false;

  let allowed = false;
  for (const part of parts) {
    const candidate = part.trim();
    if (!/^[1-9]\d*$/.test(candidate)) return false;
    const parsed = Number(candidate);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return false;
    allowed ||= parsed === userId;
  }
  return allowed;
}
