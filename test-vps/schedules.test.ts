import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  nextRunAfterOccurrence,
  parseScheduleInterval,
  ScheduleController,
  scheduleTimingDefinition,
  SCHEDULE_ICON_EMOJI,
} from "../src/vps/schedules";
import { ChatinaboxStore, type ScheduledActionRow } from "../src/vps/store";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryStore(now: () => number): ChatinaboxStore {
  const root = mkdtempSync(path.join(os.tmpdir(), "chatinabox-schedules-"));
  roots.push(root);
  return new ChatinaboxStore(path.join(root, "state.sqlite"), now);
}

function createSchedule(
  store: ChatinaboxStore,
  input: Partial<{
    kind: "message" | "task";
    timing: "once" | "interval" | "cron";
    timingValue: string;
    timezone: string;
    nextRunAt: number;
  }> = {},
) {
  return store.createScheduledAction({
    chatId: -10042,
    ownerUserId: 42,
    messageThreadId: 7,
    topicName: "Build",
    kind: input.kind ?? "message",
    name: "Daily check",
    payload: input.kind === "task" ? "Inspect the build." : "Stand up.",
    timing: input.timing ?? "interval",
    timingValue: input.timingValue ?? String(15 * 60_000),
    timezone: input.timezone ?? "UTC",
    nextRunAt: input.nextRunAt ?? 1_000_000,
  });
}

describe("schedule timing", () => {
  it("resolves one-time, interval, and timezone-aware cron schedules", () => {
    const now = Date.parse("2026-07-29T12:00:00Z");
    expect(scheduleTimingDefinition({
      at: "2026-07-30T09:00:00",
      timezone: "Asia/Dubai",
      now,
    })).toMatchObject({
      timing: "once",
      timezone: "Asia/Dubai",
      nextRunAt: Date.parse("2026-07-30T05:00:00Z"),
    });
    expect(scheduleTimingDefinition({ every: "1h 30m", now })).toMatchObject({
      timing: "interval",
      timingValue: String(90 * 60_000),
      timezone: "UTC",
      nextRunAt: now + 90 * 60_000,
    });
    expect(scheduleTimingDefinition({
      cron: "0 9 * * 1-5",
      timezone: "Europe/London",
      now,
    })).toMatchObject({
      timing: "cron",
      nextRunAt: Date.parse("2026-07-30T08:00:00Z"),
    });
  });

  it("rejects ambiguous, past, malformed, and over-frequent schedules", () => {
    const now = Date.parse("2026-07-29T12:00:00Z");
    expect(() => scheduleTimingDefinition({
      at: "2026-07-30T09:00:00Z",
      every: "1h",
      now,
    })).toThrow(/exactly one/u);
    expect(() => scheduleTimingDefinition({
      at: "2026-07-28T09:00:00Z",
      now,
    })).toThrow(/future/u);
    expect(() => scheduleTimingDefinition({
      cron: "* * *",
      now,
    })).toThrow(/five-field/u);
    expect(() => scheduleTimingDefinition({
      cron: "0 9 * * *",
      timezone: "Mars/Olympus",
      now,
    })).toThrow(/Unknown IANA timezone/u);
    expect(() => parseScheduleInterval("30s")).toThrow(/1m to 365d/u);
  });

  it("coalesces missed recurring occurrences instead of replaying a backlog", () => {
    const scheduledFor = Date.parse("2026-07-29T09:00:00Z");
    const now = Date.parse("2026-07-29T10:07:00Z");
    const interval = {
      timing: "interval",
      timing_value: String(15 * 60_000),
      timezone: "UTC",
    } as ScheduledActionRow;
    expect(nextRunAfterOccurrence(interval, scheduledFor, now))
      .toBe(Date.parse("2026-07-29T10:15:00Z"));
    expect(nextRunAfterOccurrence(
      { ...interval, timing: "once" },
      scheduledFor,
      now,
    )).toBeNull();
  });
});

describe("scheduled action ledger", () => {
  it("claims each due occurrence once and advances the durable schedule", () => {
    let now = 1_000_000;
    const store = temporaryStore(() => now);
    const schedule = createSchedule(store, { nextRunAt: now });

    const claimed = store.claimDueScheduledOccurrences(
      now,
      nextRunAfterOccurrence,
    );
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      schedule_id: schedule.id,
      status: "claimed",
      attempt_count: 1,
      scheduled_for: now,
    });
    expect(store.claimDueScheduledOccurrences(
      now,
      nextRunAfterOccurrence,
    )).toEqual([]);
    expect(store.scheduledAction(schedule.id)?.next_run_at)
      .toBe(now + 15 * 60_000);

    now += 5_000;
    store.completeScheduledOccurrence(claimed[0]!.id, "delivered", {
      telegramMessageId: 900,
    });
    expect(store.scheduledOccurrence(claimed[0]!.id)).toMatchObject({
      status: "delivered",
      telegram_message_id: 900,
      completed_at: now,
    });
    expect(store.scheduledAction(schedule.id)).toMatchObject({
      run_count: 1,
      consecutive_failures: 0,
    });
    store.close();
  });

  it("runs paused schedules manually, reclaims abandoned claims, and pauses failures", () => {
    let now = 2_000_000;
    const store = temporaryStore(() => now);
    const schedule = createSchedule(store, {
      kind: "task",
      nextRunAt: now + 60_000,
    });
    store.setScheduledActionEnabled(schedule.id, false);
    const manual = store.requestScheduledActionRunNow(schedule.id);
    expect(manual).not.toBeNull();
    const firstClaim = store.claimDueScheduledOccurrences(
      now,
      nextRunAfterOccurrence,
    );
    expect(firstClaim).toHaveLength(1);
    expect(firstClaim[0]).toMatchObject({ manual: 1, attempt_count: 1 });

    now += 5 * 60_000 + 1;
    const reclaimed = store.claimDueScheduledOccurrences(
      now,
      nextRunAfterOccurrence,
    );
    expect(reclaimed[0]).toMatchObject({
      id: firstClaim[0]!.id,
      attempt_count: 2,
    });
    for (let failure = 1; failure <= 3; failure += 1) {
      store.completeScheduledOccurrence(
        reclaimed[0]!.id,
        "failed",
        { error: `failure ${failure}` },
      );
      if (failure < 3) {
        store.requestScheduledActionRunNow(schedule.id);
        now += 1;
        reclaimed[0] = store.claimDueScheduledOccurrences(
          now,
          nextRunAfterOccurrence,
        )[0]!;
      }
    }
    expect(store.scheduledAction(schedule.id)).toMatchObject({
      enabled: 0,
      consecutive_failures: 3,
      last_error: "failure 3",
    });
    store.close();
  });

  it("retries a failed one-time occurrence twice before leaving it paused", () => {
    let now = 2_500_000;
    const store = temporaryStore(() => now);
    const schedule = createSchedule(store, {
      timing: "once",
      timingValue: "1970-01-01T00:41:40Z",
      nextRunAt: now,
    });
    for (let failure = 1; failure <= 3; failure += 1) {
      const claimed = store.claimDueScheduledOccurrences(
        now,
        nextRunAfterOccurrence,
      );
      expect(claimed).toHaveLength(1);
      store.completeScheduledOccurrence(
        claimed[0]!.id,
        "failed",
        { error: `failure ${failure}` },
      );
      const updated = store.scheduledAction(schedule.id)!;
      expect(updated.consecutive_failures).toBe(failure);
      if (failure < 3) {
        expect(updated).toMatchObject({
          enabled: 1,
          next_run_at: now + 60_000,
        });
        now += 60_000;
      }
    }
    expect(store.scheduledAction(schedule.id)).toMatchObject({
      enabled: 0,
      consecutive_failures: 3,
    });
    store.close();
  });
});

describe("schedule controller", () => {
  it("delivers messages without Codex and queues tasks through the dispatcher", async () => {
    let now = 3_000_000;
    const store = temporaryStore(() => now);
    createSchedule(store, { kind: "message", nextRunAt: now });
    createSchedule(store, { kind: "task", nextRunAt: now });
    const sendMessage = vi.fn(async () => ({ messageId: 700 }));
    const dispatchTask = vi.fn(async () => ({ ok: true as const }));
    const controller = new ScheduleController({
      env: {
        TG_BOT_TOKEN: "test",
        TG_ALLOWED_USER_IDS: "42",
        DATA_DIR: "/tmp",
        CODEX_BRIDGE_SOCKET: "/tmp/bridge.sock",
        DEFAULT_CWD: "/tmp",
      },
      store,
      now: () => now,
      sendMessage,
      dispatchTask,
    });

    await controller.runOnce();

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(dispatchTask).toHaveBeenCalledOnce();
    expect(store.recentScheduledOccurrencesForChat(-10042))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ status: "delivered", telegram_message_id: 700 }),
        expect.objectContaining({ status: "queued" }),
      ]));
    expect(SCHEDULE_ICON_EMOJI).toBe("⛅️");
    store.close();
  });

  it("records failures and warns only on the first failure and automatic pause", async () => {
    let now = 4_000_000;
    const store = temporaryStore(() => now);
    const schedule = createSchedule(store, { kind: "task", nextRunAt: now });
    const notifyFailure = vi.fn(async (
      _occurrence: unknown,
      _error: string,
      _paused: boolean,
    ) => undefined);
    const controller = new ScheduleController({
      env: {
        TG_BOT_TOKEN: "test",
        TG_ALLOWED_USER_IDS: "42",
        DATA_DIR: "/tmp",
        CODEX_BRIDGE_SOCKET: "/tmp/bridge.sock",
        DEFAULT_CWD: "/tmp",
      },
      store,
      now: () => now,
      dispatchTask: vi.fn(async () => ({
        ok: false as const,
        error: "topic unavailable",
      })),
      notifyFailure,
    });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (attempt > 1) store.requestScheduledActionRunNow(schedule.id);
      await controller.runOnce();
      now += 1;
    }

    expect(notifyFailure).toHaveBeenCalledTimes(2);
    expect(notifyFailure.mock.calls[0]?.[2]).toBe(false);
    expect(notifyFailure.mock.calls[1]?.[2]).toBe(true);
    expect(store.scheduledAction(schedule.id)).toMatchObject({
      enabled: 0,
      consecutive_failures: 3,
    });
    store.close();
  });
});
