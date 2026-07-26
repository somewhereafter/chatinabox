/** Security policy helpers shared by the Worker router and pure tests. */

const MAX_DIAGNOSTIC_ERROR_LENGTH = 180;

export const PRIVATE_BOT_RESPONSE = "🔒 This bot is private.";

/**
 * Compare operator secrets without exiting on the first differing character.
 * Missing and empty configured secrets always fail closed.
 */
export function hasAdminAccess(
  request: Request,
  configuredSecret: string | undefined,
): boolean {
  return constantTimeishEqual(
    configuredSecret,
    request.headers.get("x-admin-secret"),
  );
}

export function constantTimeishEqual(
  expected: string | null | undefined,
  provided: string | null | undefined,
): boolean {
  if (!expected || !provided) return false;

  const length = Math.max(expected.length, provided.length);
  let mismatch = expected.length ^ provided.length;
  for (let index = 0; index < length; index++) {
    mismatch |= (expected.charCodeAt(index) || 0) ^ (provided.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

/**
 * A policy is either the literal `*` or a comma-separated list of positive,
 * safe Telegram user IDs. Any missing or malformed configuration denies all.
 */
export function isTelegramUserAllowed(
  configuredPolicy: string | undefined,
  userId: number,
): boolean {
  if (!Number.isSafeInteger(userId) || userId <= 0 || configuredPolicy === undefined) {
    return false;
  }

  const policy = configuredPolicy.trim();
  if (policy === "*") return true;
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

/**
 * Convert an upstream diagnostic failure into one safe, bounded line.
 * URLs and credential-shaped values are removed before the result is capped.
 */
export function redactDiagnosticError(error: unknown): string {
  const raw = error instanceof Error
    ? error.message
    : typeof error === "string" ? error : "diagnostic failure";

  const redacted = raw
    .replace(/\b(?:https?|wss?|magnet):[^\s<>"']+/gi, "[url]")
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s<>"']*)?/gi, "[url]")
    .replace(/\b(?:bearer|bot)\s+[a-z0-9._~+/=-]+/gi, "credential=[redacted]")
    .replace(/\b\d{5,}:[a-z0-9_-]{20,}\b/gi, "[redacted]")
    .replace(
      /\b(access[_-]?token|refresh[_-]?token|token|cookie|set-cookie|authorization|api[_-]?key|secret|password|session|hash|(?:user|task|file|chat|job)[_-]?id|status(?:[_-]?msg)?[_-]?id)\b["']?\s*[:=]\s*["']?[^\s"',;}\]]+/gi,
      "$1=[redacted]",
    )
    .replace(/-?\d{5,}(?::\d+)+/g, "[id]")
    .replace(/\b[a-z0-9_-]{32,}\b/gi, "[redacted]")
    .replace(/[\r\n\t\0]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const safe = redacted || "diagnostic failure";
  return safe.length <= MAX_DIAGNOSTIC_ERROR_LENGTH
    ? safe
    : `${safe.slice(0, MAX_DIAGNOSTIC_ERROR_LENGTH - 1)}…`;
}
