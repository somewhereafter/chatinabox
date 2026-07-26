import type { TelegramResponse, TelegramUpdate } from "../telegram-types";
import type { CatinaboxEnv } from "./env";
import type { CatinaboxStore } from "./store";
import { abortableSleep } from "./sleep";

const OFFSET_KEY = "tg_update_offset";
export const TG_LAST_POLL_KEY = "tg_last_poll_at";
const LONG_POLL_SECONDS = 50;
const ERROR_BACKOFF_MS = 3_000;
const WEBHOOK_CONFLICT_BACKOFF_MS = 30_000;

export interface PollerOptions {
  readonly fetcher?: typeof fetch;
  readonly sleep?: typeof abortableSleep;
  readonly longPollSeconds?: number;
  readonly errorBackoffMs?: number;
  readonly webhookConflictBackoffMs?: number;
  readonly log?: (message: string) => void;
}

class PollCycleError extends Error {
  constructor(readonly kind: "transport" | "response" | "handler" | "webhook-conflict") {
    super(kind);
    this.name = "PollCycleError";
  }
}

/**
 * Long-polling replacement for the Worker's webhook endpoint. The VPS needs
 * no public ingress, TLS, or webhook secret: updates are pulled over
 * `getUpdates` and acknowledged by advancing the persisted offset.
 *
 * Note: Telegram serves either webhook or getUpdates, never both. While the
 * Cloudflare production webhook is registered, getUpdates returns 409.
 */
export async function runPoller(
  env: CatinaboxEnv,
  store: CatinaboxStore,
  onUpdate: (update: TelegramUpdate) => Promise<void>,
  signal: AbortSignal,
  options: PollerOptions = {},
): Promise<void> {
  let offset = Number(store.kvGet(OFFSET_KEY) ?? "0");
  if (!Number.isSafeInteger(offset) || offset < 0) offset = 0;
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ?? abortableSleep;
  const longPollSeconds = options.longPollSeconds ?? LONG_POLL_SECONDS;
  const errorBackoffMs = options.errorBackoffMs ?? ERROR_BACKOFF_MS;
  const conflictBackoffMs =
    options.webhookConflictBackoffMs ?? WEBHOOK_CONFLICT_BACKOFF_MS;
  const log = options.log ?? ((message: string) => console.error(message));

  while (!signal.aborted) {
    try {
      const resp = await fetcher(
        `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/getUpdates`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            timeout: longPollSeconds,
            offset: offset > 0 ? offset : undefined,
            allowed_updates: ["message", "callback_query"],
          }),
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout((longPollSeconds + 15) * 1_000),
          ]),
        },
      );
      let body: TelegramResponse<TelegramUpdate[]>;
      try {
        body = (await resp.json()) as TelegramResponse<TelegramUpdate[]>;
      } catch {
        throw new PollCycleError("response");
      }
      if (!body.ok || !Array.isArray(body.result)) {
        throw new PollCycleError(
          resp.status === 409 ? "webhook-conflict" : "response",
        );
      }
      store.kvSet(TG_LAST_POLL_KEY, String(Date.now()));

      for (const update of body.result) {
        if (
          !Number.isSafeInteger(update?.update_id) ||
          update.update_id < 0 ||
          (offset > 0 && update.update_id < offset)
        ) {
          throw new PollCycleError("response");
        }
        try {
          await onUpdate(update);
        } catch {
          // handleUpdate claims before doing Telegram I/O. Release that claim
          // and keep the offset unchanged so a transient failure is retried.
          store.releaseTelegramUpdate(update.update_id);
          throw new PollCycleError("handler");
        }
        offset = update.update_id + 1;
        store.kvSet(OFFSET_KEY, String(offset));
      }
    } catch (err) {
      if (signal.aborted) break;
      const kind = err instanceof PollCycleError ? err.kind : "transport";
      log(kind === "webhook-conflict"
        ? "[Poller] Telegram webhook is still active; polling remains disconnected."
        : kind === "handler"
          ? "[Poller] Update handling failed; the update will be retried."
          : "[Poller] Telegram poll cycle failed; retrying.");
      await sleep(
        kind === "webhook-conflict" ? conflictBackoffMs : errorBackoffMs,
        signal,
      ).catch(() => undefined);
    }
  }
}
