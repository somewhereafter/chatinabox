const DEFAULT_TOPIC_INTERVAL_MS = 10_000;
const DEFAULT_GROUP_INTERVAL_MS = 3_200;
const DEFAULT_PRIVATE_INTERVAL_MS = 1_000;

export interface ProgressPacer {
  tryAcquire(chatId: number, messageThreadId: number, now: number): boolean;
  record(chatId: number, messageThreadId: number, now: number): void;
}

export class TelegramProgressPacer implements ProgressPacer {
  private readonly topicRenderedAt = new Map<string, number>();
  private readonly chatRenderedAt = new Map<number, number>();

  constructor(
    private readonly topicIntervalMs = DEFAULT_TOPIC_INTERVAL_MS,
    private readonly groupIntervalMs = DEFAULT_GROUP_INTERVAL_MS,
    private readonly privateIntervalMs = DEFAULT_PRIVATE_INTERVAL_MS,
  ) {}

  tryAcquire(
    chatId: number,
    messageThreadId: number,
    now: number,
  ): boolean {
    const topicKey = `${chatId}:${messageThreadId}`;
    const topicLast = this.topicRenderedAt.get(topicKey);
    if (
      topicLast !== undefined &&
      now - topicLast < this.topicIntervalMs
    ) {
      return false;
    }
    const chatLast = this.chatRenderedAt.get(chatId);
    const chatInterval = chatId < 0
      ? this.groupIntervalMs
      : this.privateIntervalMs;
    if (chatLast !== undefined && now - chatLast < chatInterval) return false;
    this.record(chatId, messageThreadId, now);
    return true;
  }

  record(chatId: number, messageThreadId: number, now: number): void {
    this.topicRenderedAt.set(`${chatId}:${messageThreadId}`, now);
    this.chatRenderedAt.set(chatId, now);
  }
}
