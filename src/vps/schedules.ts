import { Cron } from "croner";
import {
  escapeTelegramHtml,
  tgSend,
  tgSendRichHtml,
} from "../telegram";
import type { ChatinaboxEnv } from "./env";
import { abortableSleep } from "./sleep";
import type {
  ChatinaboxStore,
  ClaimedScheduledOccurrence,
  ScheduledActionRow,
  ScheduledActionTiming,
} from "./store";

export const SCHEDULE_ICON_EMOJI = "⛅️";
export const SCHEDULE_POLL_MS = 5_000;
export const MIN_SCHEDULE_INTERVAL_MS = 60_000;
export const MAX_SCHEDULE_INTERVAL_MS = 365 * 24 * 60 * 60 * 1_000;

export interface ScheduleTimingDefinition {
  readonly timing: ScheduledActionTiming;
  readonly timingValue: string;
  readonly timezone: string;
  readonly nextRunAt: number;
}

interface ScheduleControllerDependencies {
  readonly env: ChatinaboxEnv;
  readonly store: ChatinaboxStore;
  readonly now?: () => number;
  readonly pollMs?: number;
  readonly dispatchTask: (
    occurrence: ClaimedScheduledOccurrence,
  ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }>;
  readonly sendMessage?: (
    occurrence: ClaimedScheduledOccurrence,
  ) => Promise<{ readonly messageId: number }>;
  readonly notifyFailure?: (
    occurrence: ClaimedScheduledOccurrence,
    error: string,
    paused: boolean,
  ) => Promise<void>;
}

export class ScheduleController {
  private readonly now: () => number;
  private readonly pollMs: number;

  constructor(private readonly dependencies: ScheduleControllerDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.pollMs = dependencies.pollMs ?? SCHEDULE_POLL_MS;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.runOnce().catch((error) => {
        console.error(
          `[ChatinaboxSchedules] pass failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      });
      await abortableSleep(this.pollMs, signal).catch(() => undefined);
    }
  }

  async runOnce(): Promise<void> {
    const occurrences = this.dependencies.store.claimDueScheduledOccurrences(
      this.now(),
      nextRunAfterOccurrence,
    );
    for (const occurrence of occurrences) {
      await this.dispatch(occurrence);
    }
  }

  private async dispatch(
    occurrence: ClaimedScheduledOccurrence,
  ): Promise<void> {
    try {
      if (occurrence.schedule.kind === "message") {
        const sent = await (
          this.dependencies.sendMessage?.(occurrence) ??
            this.sendScheduledMessage(occurrence)
        );
        this.dependencies.store.completeScheduledOccurrence(
          occurrence.id,
          "delivered",
          { telegramMessageId: sent.messageId },
        );
        return;
      }
      const result = await this.dependencies.dispatchTask(occurrence);
      if (!result.ok) throw new Error(result.error);
      this.dependencies.store.completeScheduledOccurrence(
        occurrence.id,
        "queued",
      );
    } catch (error) {
      const detail = error instanceof Error
        ? error.message
        : "scheduled dispatch failed";
      const schedule = this.dependencies.store.completeScheduledOccurrence(
        occurrence.id,
        "failed",
        { error: detail },
      );
      if (
        occurrence.schedule.kind === "task" &&
        (schedule?.consecutive_failures === 1 || schedule?.enabled === 0)
      ) {
        await (
          this.dependencies.notifyFailure?.(
            occurrence,
            detail,
            schedule?.enabled === 0,
          ) ??
            this.sendFailureNotice(
              occurrence,
              detail,
              schedule?.enabled === 0,
            )
        ).catch(() => undefined);
      }
    }
  }

  private async sendScheduledMessage(
    occurrence: ClaimedScheduledOccurrence,
  ): Promise<{ readonly messageId: number }> {
    const response = await tgSendRichHtml(
      this.dependencies.env,
      occurrence.schedule.chat_id,
      formatScheduledMessage(occurrence.schedule),
      undefined,
      undefined,
      occurrence.schedule.message_thread_id || undefined,
    );
    if (!response.ok) {
      throw new Error(
        response.description || "Telegram rejected the scheduled message",
      );
    }
    return { messageId: response.result.message_id };
  }

  private async sendFailureNotice(
    occurrence: ClaimedScheduledOccurrence,
    error: string,
    paused: boolean,
  ): Promise<void> {
    await tgSend(
      this.dependencies.env,
      occurrence.schedule.chat_id,
      `${SCHEDULE_ICON_EMOJI} <b>Scheduled task failed</b>\n` +
        `${escapeTelegramHtml(occurrence.schedule.name)}\n\n` +
        `${escapeTelegramHtml(error)}\n` +
        (paused
          ? "\nPaused after three consecutive failures."
          : "\nIt will try again on its next occurrence."),
      undefined,
      undefined,
      occurrence.schedule.message_thread_id || undefined,
    );
  }
}

export function scheduleTimingDefinition(input: {
  readonly at?: string;
  readonly every?: string;
  readonly cron?: string;
  readonly timezone?: string;
  readonly now?: number;
}): ScheduleTimingDefinition {
  const supplied = [input.at, input.every, input.cron]
    .filter((value) => value !== undefined);
  if (supplied.length !== 1) {
    throw new Error("Choose exactly one of --at, --every, or --cron");
  }
  const now = input.now ?? Date.now();
  const timezone = normalizeTimezone(input.timezone ?? "UTC");
  if (input.at !== undefined) {
    const timingValue = input.at.trim();
    const nextRunAt = onceTimestamp(timingValue, timezone);
    if (nextRunAt <= now) throw new Error("--at must be in the future");
    return { timing: "once", timingValue, timezone, nextRunAt };
  }
  if (input.every !== undefined) {
    const interval = parseScheduleInterval(input.every);
    return {
      timing: "interval",
      timingValue: String(interval),
      timezone: "UTC",
      nextRunAt: now + interval,
    };
  }
  const timingValue = normalizeCron(input.cron!);
  const nextRunAt = nextCronTimestamp(timingValue, timezone, now);
  return { timing: "cron", timingValue, timezone, nextRunAt };
}

export function nextRunAfterOccurrence(
  schedule: ScheduledActionRow,
  scheduledFor: number,
  now: number,
): number | null {
  if (schedule.timing === "once") return null;
  if (schedule.timing === "interval") {
    const interval = numericInterval(schedule.timing_value);
    const elapsed = Math.max(0, now - scheduledFor);
    const steps = Math.floor(elapsed / interval) + 1;
    return scheduledFor + steps * interval;
  }
  return nextCronTimestamp(
    schedule.timing_value,
    schedule.timezone,
    now,
  );
}

export function nextRunFromNow(
  schedule: Pick<
    ScheduledActionRow,
    "timing" | "timing_value" | "timezone"
  >,
  now: number = Date.now(),
): number | null {
  if (schedule.timing === "once") {
    const timestamp = onceTimestamp(
      schedule.timing_value,
      schedule.timezone,
    );
    return timestamp > now ? timestamp : null;
  }
  if (schedule.timing === "interval") {
    return now + numericInterval(schedule.timing_value);
  }
  return nextCronTimestamp(schedule.timing_value, schedule.timezone, now);
}

export function parseScheduleInterval(value: string): number {
  const compact = value.replace(/\s+/gu, "").toLowerCase();
  if (!compact) throw new Error("--every requires a duration such as 15m");
  const matcher = /(\d+)([mhdw])/gu;
  let total = 0;
  let consumed = "";
  for (const match of compact.matchAll(matcher)) {
    consumed += match[0];
    const amount = Number(match[1]);
    const unit = match[2];
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new Error("Schedule interval values must be positive integers");
    }
    const multiplier =
      unit === "m"
        ? 60_000
        : unit === "h"
          ? 60 * 60_000
          : unit === "d"
            ? 24 * 60 * 60_000
            : 7 * 24 * 60 * 60_000;
    total += amount * multiplier;
  }
  if (
    consumed !== compact ||
    !Number.isSafeInteger(total) ||
    total < MIN_SCHEDULE_INTERVAL_MS ||
    total > MAX_SCHEDULE_INTERVAL_MS
  ) {
    throw new Error(
      "--every must be from 1m to 365d, for example 15m, 2h, or 1d",
    );
  }
  return total;
}

export function scheduleTimingText(
  schedule: Pick<
    ScheduledActionRow,
    "timing" | "timing_value" | "timezone" | "next_run_at"
  >,
): string {
  if (schedule.timing === "once") {
    return `once · ${formatScheduleTime(schedule.next_run_at)}`;
  }
  if (schedule.timing === "interval") {
    return `every ${formatInterval(numericInterval(schedule.timing_value))}`;
  }
  return `cron ${schedule.timing_value} · ${schedule.timezone}`;
}

function formatScheduledMessage(schedule: ScheduledActionRow): string {
  return (
    `<mark>${SCHEDULE_ICON_EMOJI} scheduled message</mark>\n\n` +
    `<b>${escapeTelegramHtml(schedule.name)}</b>\n` +
    `${escapeTelegramHtml(schedule.payload)}`
  );
}

function onceTimestamp(value: string, timezone: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u.test(value)) {
    throw new Error(
      "--at must be an ISO date-time such as 2026-07-30T09:00:00Z",
    );
  }
  let job: Cron | null = null;
  try {
    job = new Cron(value, { timezone, paused: true });
    const once = job.getOnce();
    if (!once || !Number.isFinite(once.getTime())) {
      throw new Error("The one-time schedule could not be resolved");
    }
    return once.getTime();
  } catch (error) {
    throw new Error(
      `Invalid one-time schedule: ${
        error instanceof Error ? error.message : "unknown date"
      }`,
    );
  } finally {
    job?.stop();
  }
}

function normalizeCron(value: string): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (normalized.split(" ").length !== 5) {
    throw new Error("--cron requires a standard five-field cron expression");
  }
  return normalized;
}

function nextCronTimestamp(
  pattern: string,
  timezone: string,
  after: number,
): number {
  let job: Cron | null = null;
  try {
    job = new Cron(normalizeCron(pattern), {
      timezone: normalizeTimezone(timezone),
      paused: true,
    });
    const next = job.nextRun(new Date(after));
    if (!next || !Number.isFinite(next.getTime())) {
      throw new Error("No future occurrence could be found");
    }
    return next.getTime();
  } catch (error) {
    throw new Error(
      `Invalid cron schedule: ${
        error instanceof Error ? error.message : "unknown expression"
      }`,
    );
  } finally {
    job?.stop();
  }
}

function normalizeTimezone(value: string): string {
  const timezone = value.trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
  } catch {
    throw new Error(`Unknown IANA timezone: ${timezone}`);
  }
  return timezone;
}

function numericInterval(value: string): number {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < MIN_SCHEDULE_INTERVAL_MS ||
    parsed > MAX_SCHEDULE_INTERVAL_MS
  ) {
    throw new Error("Stored schedule interval is invalid");
  }
  return parsed;
}

function formatInterval(milliseconds: number): string {
  const minutes = milliseconds / 60_000;
  if (minutes % (7 * 24 * 60) === 0) {
    return `${minutes / (7 * 24 * 60)}w`;
  }
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function formatScheduleTime(timestamp: number | null): string {
  return timestamp === null
    ? "not scheduled"
    : new Date(timestamp).toISOString().replace(".000Z", "Z");
}
