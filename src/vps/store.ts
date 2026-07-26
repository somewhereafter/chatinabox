import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  MAX_CALLBACK_PAYLOAD_BYTES,
  MAX_CALLBACK_TTL_MS,
  isCallbackAction,
  type CallbackReferenceStore,
  type PersistedCallbackReference,
} from "../telegram-callback";
import type {
  CodexAssistantName,
  CodexPane,
  CodexPaneIdentity,
} from "./codex-bridge-protocol";

export interface CodexAttachmentRow {
  chat_id: number;
  owner_user_id: number;
  server_pid: number;
  pane_id: string;
  pane_pid: number;
  session_name: string;
  window_name: string;
  assistant_name: CodexAssistantName;
  cwd: string;
  attached_at: number;
}

export interface CodexPromptRow {
  id: number;
  chat_id: number;
  owner_user_id: number;
  server_pid: number;
  pane_id: string;
  pane_pid: number;
  telegram_message_id: number;
  created_at: number;
  delivered_at: number | null;
}

export interface CodexStatusRow {
  chat_id: number;
  owner_user_id: number;
  server_pid: number;
  pane_id: string;
  pane_pid: number;
  telegram_message_id: number;
  updated_at: number;
}

export interface CodexQueueStatusRow extends CodexStatusRow {
  message_count: number;
}

export interface CodexQueuedPromptRow {
  id: number;
  chat_id: number;
  owner_user_id: number;
  server_pid: number;
  pane_id: string;
  pane_pid: number;
  telegram_message_id: number;
  text: string;
  created_at: number;
}

const CALLBACK_REFERENCE_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const CALLBACKS_PER_OWNER_CAP = 128;
const CALLBACKS_GLOBAL_CAP = 4_096;
const MAX_CALLBACK_RECORD_BYTES = MAX_CALLBACK_PAYLOAD_BYTES + 1_024;
const TELEGRAM_UPDATE_RETENTION_MS = 48 * 60 * 60 * 1_000;

/**
 * Single-file state store for Telegram ownership, session routing, queued
 * prompts, status messages, callback references, and update deduplication.
 */
export class ChatinaboxStore {
  private readonly db: DatabaseSync;

  constructor(databasePath: string, private readonly now: () => number = Date.now) {
    this.db = new DatabaseSync(databasePath);
    // The database contains Telegram ownership and message state.
    chmodSync(databasePath, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS seen_updates (
        update_id INTEGER PRIMARY KEY,
        seen_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS callbacks (
        reference TEXT PRIMARY KEY,
        chat_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        record TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS codex_attachments (
        chat_id INTEGER NOT NULL,
        owner_user_id INTEGER NOT NULL,
        server_pid INTEGER NOT NULL,
        pane_id TEXT NOT NULL,
        pane_pid INTEGER NOT NULL,
        session_name TEXT NOT NULL,
        window_name TEXT NOT NULL,
        assistant_name TEXT NOT NULL DEFAULT 'Codex',
        cwd TEXT NOT NULL,
        attached_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, owner_user_id)
      );
      CREATE INDEX IF NOT EXISTS codex_attachments_target_idx
        ON codex_attachments(server_pid, pane_id, pane_pid);
      CREATE TABLE IF NOT EXISTS codex_prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        owner_user_id INTEGER NOT NULL,
        server_pid INTEGER NOT NULL,
        pane_id TEXT NOT NULL,
        pane_pid INTEGER NOT NULL,
        telegram_message_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS codex_prompts_pending_idx
        ON codex_prompts(
          server_pid, pane_id, pane_pid, delivered_at, created_at, id
        );
      CREATE TABLE IF NOT EXISTS codex_status_messages (
        chat_id INTEGER NOT NULL,
        owner_user_id INTEGER NOT NULL,
        server_pid INTEGER NOT NULL,
        pane_id TEXT NOT NULL,
        pane_pid INTEGER NOT NULL,
        telegram_message_id INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, owner_user_id)
      );
      CREATE TABLE IF NOT EXISTS codex_queue_status_messages (
        chat_id INTEGER NOT NULL,
        owner_user_id INTEGER NOT NULL,
        server_pid INTEGER NOT NULL,
        pane_id TEXT NOT NULL,
        pane_pid INTEGER NOT NULL,
        telegram_message_id INTEGER NOT NULL,
        message_count INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, owner_user_id)
      );
      CREATE TABLE IF NOT EXISTS codex_final_deliveries (
        chat_id INTEGER NOT NULL,
        owner_user_id INTEGER NOT NULL,
        server_pid INTEGER NOT NULL,
        pane_id TEXT NOT NULL,
        pane_pid INTEGER NOT NULL,
        message_hash TEXT NOT NULL,
        delivered_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, owner_user_id)
      );
      CREATE TABLE IF NOT EXISTS codex_queued_prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        owner_user_id INTEGER NOT NULL,
        server_pid INTEGER NOT NULL,
        pane_id TEXT NOT NULL,
        pane_pid INTEGER NOT NULL,
        telegram_message_id INTEGER NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS codex_queued_prompts_target_idx
        ON codex_queued_prompts(
          server_pid, pane_id, pane_pid, created_at, id
        );
    `);
    this.migrateCodexAttachments();
  }

  close(): void {
    this.db.close();
  }

  // ── key/value ─────────────────────────────────────────
  kvGet(key: string): string | null {
    const row = this.db
      .prepare(`SELECT v FROM kv WHERE k = ?`)
      .get(key) as { v: string } | undefined;
    return row?.v ?? null;
  }

  kvSet(key: string, value: string): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)`)
      .run(key, value);
  }

  // ── Telegram ↔ Codex attachments ─────────────────────
  codexAttachment(
    chatId: number,
    ownerUserId: number,
  ): CodexAttachmentRow | null {
    return (
      (this.db.prepare(`
        SELECT * FROM codex_attachments
        WHERE chat_id = ? AND owner_user_id = ?
      `).get(chatId, ownerUserId) as CodexAttachmentRow | undefined) ?? null
    );
  }

  codexAttachmentsForTarget(
    target: CodexPaneIdentity,
  ): CodexAttachmentRow[] {
    return this.db.prepare(`
      SELECT * FROM codex_attachments
      WHERE server_pid = ? AND pane_id = ? AND pane_pid = ?
      ORDER BY attached_at
    `).all(
      target.serverPid,
      target.paneId,
      target.panePid,
    ) as unknown as CodexAttachmentRow[];
  }

  attachCodex(
    chatId: number,
    ownerUserId: number,
    pane: CodexPane,
  ): CodexAttachmentRow {
    this.db.prepare(`
      INSERT INTO codex_attachments (
        chat_id, owner_user_id, server_pid, pane_id, pane_pid,
        session_name, window_name, assistant_name, cwd, attached_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id, owner_user_id) DO UPDATE SET
        server_pid = excluded.server_pid,
        pane_id = excluded.pane_id,
        pane_pid = excluded.pane_pid,
        session_name = excluded.session_name,
        window_name = excluded.window_name,
        assistant_name = excluded.assistant_name,
        cwd = excluded.cwd,
        attached_at = excluded.attached_at
    `).run(
      chatId,
      ownerUserId,
      pane.serverPid,
      pane.paneId,
      pane.panePid,
      pane.sessionName,
      pane.windowName,
      pane.assistantName ?? "Codex",
      pane.cwd,
      this.now(),
    );
    return this.codexAttachment(chatId, ownerUserId)!;
  }

  renameAttachedCodexTarget(
    target: CodexPaneIdentity,
    pane: CodexPane,
  ): void {
    this.db.prepare(`
      UPDATE codex_attachments
      SET session_name = ?, window_name = ?, cwd = ?
      WHERE server_pid = ? AND pane_id = ? AND pane_pid = ?
    `).run(
      pane.sessionName,
      pane.windowName,
      pane.cwd,
      target.serverPid,
      target.paneId,
      target.panePid,
    );
  }

  setCodexAssistantNameForTarget(
    target: CodexPaneIdentity,
    assistantName: CodexAssistantName,
  ): void {
    this.db.prepare(`
      UPDATE codex_attachments SET assistant_name = ?
      WHERE server_pid = ? AND pane_id = ? AND pane_pid = ?
    `).run(
      assistantName,
      target.serverPid,
      target.paneId,
      target.panePid,
    );
  }

  detachCodex(chatId: number, ownerUserId: number): boolean {
    const detached = this.db.prepare(`
      DELETE FROM codex_attachments
      WHERE chat_id = ? AND owner_user_id = ?
    `).run(chatId, ownerUserId).changes > 0;
    if (detached) {
      this.db.prepare(`
        DELETE FROM codex_queued_prompts
        WHERE chat_id = ? AND owner_user_id = ?
      `).run(chatId, ownerUserId);
      this.db.prepare(`
        DELETE FROM codex_queue_status_messages
        WHERE chat_id = ? AND owner_user_id = ?
      `).run(chatId, ownerUserId);
    }
    return detached;
  }

  recordCodexPrompt(
    chatId: number,
    ownerUserId: number,
    target: CodexPaneIdentity,
    telegramMessageId: number,
  ): void {
    this.db.prepare(`
      INSERT INTO codex_prompts (
        chat_id, owner_user_id, server_pid, pane_id, pane_pid,
        telegram_message_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      chatId,
      ownerUserId,
      target.serverPid,
      target.paneId,
      target.panePid,
      telegramMessageId,
      this.now(),
    );
    this.db.prepare(`
      DELETE FROM codex_prompts
      WHERE id NOT IN (
        SELECT id FROM codex_prompts ORDER BY id DESC LIMIT 1000
      )
    `).run();
  }

  nextCodexPrompt(
    chatId: number,
    ownerUserId: number,
    target: CodexPaneIdentity,
  ): CodexPromptRow | null {
    return this.pendingCodexPromptsThrough(
      chatId,
      ownerUserId,
      target,
      Number.MAX_SAFE_INTEGER,
    )[0] ?? null;
  }

  markCodexPromptDelivered(id: number): void {
    this.db.prepare(`
      UPDATE codex_prompts SET delivered_at = ?
      WHERE id = ? AND delivered_at IS NULL
    `).run(this.now(), id);
  }

  pendingCodexPromptsThrough(
    chatId: number,
    ownerUserId: number,
    target: CodexPaneIdentity,
    createdThrough: number,
  ): CodexPromptRow[] {
    return this.db.prepare(`
      SELECT * FROM codex_prompts
      WHERE chat_id = ? AND owner_user_id = ?
        AND server_pid = ? AND pane_id = ? AND pane_pid = ?
        AND delivered_at IS NULL AND created_at <= ?
      ORDER BY created_at, id
      LIMIT 100
    `).all(
      chatId,
      ownerUserId,
      target.serverPid,
      target.paneId,
      target.panePid,
      createdThrough,
    ) as unknown as CodexPromptRow[];
  }

  markCodexPromptsDelivered(ids: readonly number[]): void {
    if (ids.length === 0) return;
    if (
      ids.length > 100 ||
      ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
    ) {
      throw new Error("Invalid Codex prompt ids");
    }
    const placeholders = ids.map(() => "?").join(",");
    this.db.prepare(`
      UPDATE codex_prompts SET delivered_at = ?
      WHERE delivered_at IS NULL AND id IN (${placeholders})
    `).run(this.now(), ...ids);
  }

  queueCodexPrompt(
    chatId: number,
    ownerUserId: number,
    target: CodexPaneIdentity,
    telegramMessageId: number,
    text: string,
  ): number {
    this.db.prepare(`
      INSERT INTO codex_queued_prompts (
        chat_id, owner_user_id, server_pid, pane_id, pane_pid,
        telegram_message_id, text, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      chatId,
      ownerUserId,
      target.serverPid,
      target.paneId,
      target.panePid,
      telegramMessageId,
      text,
      this.now(),
    );
    const count = this.queuedCodexPrompts(
      chatId,
      ownerUserId,
      target,
    ).length;
    this.db.prepare(`
      DELETE FROM codex_queued_prompts
      WHERE id NOT IN (
        SELECT id FROM codex_queued_prompts ORDER BY id DESC LIMIT 1000
      )
    `).run();
    return count;
  }

  queuedCodexPromptGroups(): Array<{
    chat_id: number;
    owner_user_id: number;
    server_pid: number;
    pane_id: string;
    pane_pid: number;
  }> {
    return this.db.prepare(`
      SELECT chat_id, owner_user_id, server_pid, pane_id, pane_pid
      FROM codex_queued_prompts
      GROUP BY chat_id, owner_user_id, server_pid, pane_id, pane_pid
      ORDER BY MIN(created_at), MIN(id)
    `).all() as unknown as Array<{
      chat_id: number;
      owner_user_id: number;
      server_pid: number;
      pane_id: string;
      pane_pid: number;
    }>;
  }

  queuedCodexPrompts(
    chatId: number,
    ownerUserId: number,
    target: CodexPaneIdentity,
  ): CodexQueuedPromptRow[] {
    return this.db.prepare(`
      SELECT * FROM codex_queued_prompts
      WHERE chat_id = ? AND owner_user_id = ?
        AND server_pid = ? AND pane_id = ? AND pane_pid = ?
      ORDER BY created_at, id
      LIMIT 50
    `).all(
      chatId,
      ownerUserId,
      target.serverPid,
      target.paneId,
      target.panePid,
    ) as unknown as CodexQueuedPromptRow[];
  }

  deleteQueuedCodexPrompts(ids: readonly number[]): void {
    if (ids.length === 0) return;
    if (
      ids.length > 50 ||
      ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
    ) {
      throw new Error("Invalid queued Codex prompt ids");
    }
    const placeholders = ids.map(() => "?").join(",");
    this.db.prepare(`
      DELETE FROM codex_queued_prompts
      WHERE id IN (${placeholders})
    `).run(...ids);
  }

  codexStatus(
    chatId: number,
    ownerUserId: number,
    target: CodexPaneIdentity,
  ): CodexStatusRow | null {
    return (
      (this.db.prepare(`
        SELECT * FROM codex_status_messages
        WHERE chat_id = ? AND owner_user_id = ?
          AND server_pid = ? AND pane_id = ? AND pane_pid = ?
      `).get(
        chatId,
        ownerUserId,
        target.serverPid,
        target.paneId,
        target.panePid,
      ) as CodexStatusRow | undefined) ?? null
    );
  }

  setCodexStatus(
    chatId: number,
    ownerUserId: number,
    target: CodexPaneIdentity,
    telegramMessageId: number,
  ): void {
    this.db.prepare(`
      INSERT INTO codex_status_messages (
        chat_id, owner_user_id, server_pid, pane_id, pane_pid,
        telegram_message_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id, owner_user_id) DO UPDATE SET
        server_pid = excluded.server_pid,
        pane_id = excluded.pane_id,
        pane_pid = excluded.pane_pid,
        telegram_message_id = excluded.telegram_message_id,
        updated_at = excluded.updated_at
    `).run(
      chatId,
      ownerUserId,
      target.serverPid,
      target.paneId,
      target.panePid,
      telegramMessageId,
      this.now(),
    );
  }

  clearCodexStatus(
    chatId: number,
    ownerUserId: number,
    target: CodexPaneIdentity,
  ): CodexStatusRow | null {
    const row = this.codexStatus(chatId, ownerUserId, target);
    if (!row) return null;
    this.db.prepare(`
      DELETE FROM codex_status_messages
      WHERE chat_id = ? AND owner_user_id = ?
        AND server_pid = ? AND pane_id = ? AND pane_pid = ?
    `).run(
      chatId,
      ownerUserId,
      target.serverPid,
      target.paneId,
      target.panePid,
    );
    return row;
  }

  codexQueueStatus(
    chatId: number,
    ownerUserId: number,
    target: CodexPaneIdentity,
  ): CodexQueueStatusRow | null {
    return (
      (this.db.prepare(`
        SELECT * FROM codex_queue_status_messages
        WHERE chat_id = ? AND owner_user_id = ?
          AND server_pid = ? AND pane_id = ? AND pane_pid = ?
      `).get(
        chatId,
        ownerUserId,
        target.serverPid,
        target.paneId,
        target.panePid,
      ) as CodexQueueStatusRow | undefined) ?? null
    );
  }

  setCodexQueueStatus(
    chatId: number,
    ownerUserId: number,
    target: CodexPaneIdentity,
    telegramMessageId: number,
    messageCount: number,
  ): void {
    if (!Number.isSafeInteger(messageCount) || messageCount <= 0) {
      throw new Error("Invalid Codex queue status count");
    }
    this.db.prepare(`
      INSERT INTO codex_queue_status_messages (
        chat_id, owner_user_id, server_pid, pane_id, pane_pid,
        telegram_message_id, message_count, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id, owner_user_id) DO UPDATE SET
        server_pid = excluded.server_pid,
        pane_id = excluded.pane_id,
        pane_pid = excluded.pane_pid,
        telegram_message_id = excluded.telegram_message_id,
        message_count = excluded.message_count,
        updated_at = excluded.updated_at
    `).run(
      chatId,
      ownerUserId,
      target.serverPid,
      target.paneId,
      target.panePid,
      telegramMessageId,
      messageCount,
      this.now(),
    );
  }

  clearCodexQueueStatus(
    chatId: number,
    ownerUserId: number,
    target: CodexPaneIdentity,
  ): CodexQueueStatusRow | null {
    const row = this.codexQueueStatus(chatId, ownerUserId, target);
    if (!row) return null;
    this.db.prepare(`
      DELETE FROM codex_queue_status_messages
      WHERE chat_id = ? AND owner_user_id = ?
        AND server_pid = ? AND pane_id = ? AND pane_pid = ?
    `).run(
      chatId,
      ownerUserId,
      target.serverPid,
      target.paneId,
      target.panePid,
    );
    return row;
  }

  isRecentDuplicateCodexFinal(
    chatId: number,
    ownerUserId: number,
    target: CodexPaneIdentity,
    messageHash: string,
    windowMs = 30_000,
  ): boolean {
    const row = this.db.prepare(`
      SELECT message_hash, delivered_at
      FROM codex_final_deliveries
      WHERE chat_id = ? AND owner_user_id = ?
        AND server_pid = ? AND pane_id = ? AND pane_pid = ?
    `).get(
      chatId,
      ownerUserId,
      target.serverPid,
      target.paneId,
      target.panePid,
    ) as { message_hash: string; delivered_at: number } | undefined;
    return (
      row?.message_hash === messageHash &&
      this.now() - row.delivered_at >= 0 &&
      this.now() - row.delivered_at <= windowMs
    );
  }

  recordCodexFinalDelivery(
    chatId: number,
    ownerUserId: number,
    target: CodexPaneIdentity,
    messageHash: string,
  ): void {
    this.db.prepare(`
      INSERT INTO codex_final_deliveries (
        chat_id, owner_user_id, server_pid, pane_id, pane_pid,
        message_hash, delivered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id, owner_user_id) DO UPDATE SET
        server_pid = excluded.server_pid,
        pane_id = excluded.pane_id,
        pane_pid = excluded.pane_pid,
        message_hash = excluded.message_hash,
        delivered_at = excluded.delivered_at
    `).run(
      chatId,
      ownerUserId,
      target.serverPid,
      target.paneId,
      target.panePid,
      messageHash,
      this.now(),
    );
  }

  // ── Telegram update dedupe ────────────────────────────
  /** Returns true when this update id has not been processed before. */
  claimTelegramUpdate(updateId: number): boolean {
    const result = this.db
      .prepare(`INSERT OR IGNORE INTO seen_updates (update_id, seen_at) VALUES (?, ?)`)
      .run(updateId, this.now());
    this.db
      .prepare(`DELETE FROM seen_updates WHERE seen_at < ?`)
      .run(this.now() - TELEGRAM_UPDATE_RETENTION_MS);
    return result.changes > 0;
  }

  /** Release a failed in-flight update so the poller can retry it. */
  releaseTelegramUpdate(updateId: number): void {
    this.db.prepare(`DELETE FROM seen_updates WHERE update_id = ?`).run(updateId);
  }

  // ── Callback references ───────────────────────────────
  callbackStore(): CallbackReferenceStore {
    return new SqliteCallbackStore(this.db, this.now);
  }

  private migrateCodexAttachments(): void {
    const columns = new Set(
      (this.db.prepare(`PRAGMA table_info(codex_attachments)`).all() as unknown as
        Array<{ name: string }>).map((column) => column.name),
    );
    if (!columns.has("assistant_name")) {
      this.db.exec(`
        ALTER TABLE codex_attachments
        ADD COLUMN assistant_name TEXT NOT NULL DEFAULT 'Codex'
      `);
    }
  }
}

/** CallbackReferenceStore adapter backed by the local SQLite database. */
class SqliteCallbackStore implements CallbackReferenceStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
  ) {}

  async put(
    record: PersistedCallbackReference<unknown>,
    ttlSeconds: number,
  ): Promise<void> {
    const now = this.now();
    if (
      !CALLBACK_REFERENCE_PATTERN.test(record.reference) ||
      record.version !== 1 ||
      !isCallbackAction(record.action) ||
      !Number.isSafeInteger(record.chatId) ||
      !Number.isSafeInteger(record.userId) ||
      !Number.isFinite(ttlSeconds) ||
      ttlSeconds <= 0 ||
      ttlSeconds * 1_000 > MAX_CALLBACK_TTL_MS
    ) {
      throw new Error("Invalid callback reference record");
    }
    const serialized = JSON.stringify(record);
    if (Buffer.byteLength(serialized, "utf8") > MAX_CALLBACK_RECORD_BYTES) {
      throw new Error("Callback reference record too large");
    }

    this.cleanup(now);

    // Per-owner and global caps: evict the owner's oldest references first so
    // one chat spamming buttons cannot starve every other owner.
    const ownerCount = this.count(
      `SELECT COUNT(*) AS n FROM callbacks WHERE chat_id = ? AND user_id = ?`,
      [record.chatId, record.userId],
    );
    if (ownerCount >= CALLBACKS_PER_OWNER_CAP) {
      this.db
        .prepare(
          `DELETE FROM callbacks WHERE reference IN (
             SELECT reference FROM callbacks WHERE chat_id = ? AND user_id = ?
             ORDER BY expires_at LIMIT ?)`,
        )
        .run(record.chatId, record.userId, ownerCount - CALLBACKS_PER_OWNER_CAP + 1);
    }
    if (this.count(`SELECT COUNT(*) AS n FROM callbacks`, []) >= CALLBACKS_GLOBAL_CAP) {
      throw new Error("Callback reference store is full");
    }

    this.db
      .prepare(
        `INSERT OR REPLACE INTO callbacks (reference, chat_id, user_id, record, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        record.reference,
        record.chatId,
        record.userId,
        serialized,
        now + ttlSeconds * 1_000,
      );
  }

  async get(
    reference: string,
  ): Promise<PersistedCallbackReference<unknown> | null> {
    if (!CALLBACK_REFERENCE_PATTERN.test(reference)) return null;
    const row = this.db
      .prepare(`SELECT record, expires_at FROM callbacks WHERE reference = ?`)
      .get(reference) as { record: string; expires_at: number } | undefined;
    if (!row || row.expires_at <= this.now()) return null;

    try {
      const parsed = JSON.parse(row.record) as PersistedCallbackReference<unknown>;
      return parsed.reference === reference ? parsed : null;
    } catch {
      return null;
    }
  }

  async delete(reference: string): Promise<void> {
    if (!CALLBACK_REFERENCE_PATTERN.test(reference)) return;
    this.db.prepare(`DELETE FROM callbacks WHERE reference = ?`).run(reference);
  }

  private cleanup(now: number): void {
    this.db.prepare(`DELETE FROM callbacks WHERE expires_at <= ?`).run(now);
  }

  private count(sql: string, params: (number | string)[]): number {
    const row = this.db.prepare(sql).get(...params) as { n: number };
    return Number(row.n);
  }
}
