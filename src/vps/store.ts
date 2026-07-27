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
  CodexGoalStatus,
  CodexPane,
  CodexPaneIdentity,
  CodexThreadGoal,
} from "./codex-bridge-protocol";

export interface CodexAttachmentRow {
  chat_id: number;
  owner_user_id: number;
  message_thread_id: number;
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
  queued_for_next_turn: number;
}

export interface CodexStatusRow {
  chat_id: number;
  owner_user_id: number;
  server_pid: number;
  pane_id: string;
  pane_pid: number;
  telegram_message_id: number;
  status_kind: string;
  tool_calls: number;
  edited_files: number;
  explored_things: number;
  active_shells: number;
  queued_messages: number;
  reply_to_message_id: number | null;
  started_at: number;
  updated_at: number;
}

export interface CodexStatusSnapshot {
  readonly statusKind: string;
  readonly toolCalls: number;
  readonly editedFiles: number;
  readonly exploredThings: number;
  readonly activeShells: number;
  readonly queuedMessages: number;
  readonly replyToMessageId: number | null;
  readonly startedAt: number;
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

export interface CodexThinkingSectionRow {
  chat_id: number;
  owner_user_id: number;
  server_pid: number;
  pane_id: string;
  pane_pid: number;
  summaries_json: string;
  omitted_count: number;
  telegram_message_id: number | null;
  created_at: number;
  updated_at: number;
  rendered_at: number;
}

export interface CodexGoalRow {
  chat_id: number;
  owner_user_id: number;
  message_thread_id: number;
  thread_id: string;
  objective: string;
  status: CodexGoalStatus;
  token_budget: number | null;
  tokens_used: number;
  time_used_seconds: number;
  goal_created_at: number;
  goal_updated_at: number;
  observed_at: number;
  awaiting_edit: number;
}

export interface CodexGoalHistoryRow {
  id: number;
  chat_id: number;
  owner_user_id: number;
  message_thread_id: number;
  thread_id: string;
  topic_name: string;
  objective: string;
  tokens_used: number;
  time_used_seconds: number;
  goal_created_at: number;
  completed_at: number;
  telegram_message_id: number | null;
}

export interface OverviewDashboardRow {
  chat_id: number;
  owner_user_id: number;
  message_thread_id: number;
  dashboard_message_id: number | null;
  render_signature: string;
  rendered_at: number;
  updated_at: number;
}

export interface ManagerTopicRow {
  chat_id: number;
  owner_user_id: number;
  message_thread_id: number;
  server_pid: number | null;
  pane_id: string | null;
  pane_pid: number | null;
  updated_at: number;
}

export type TopicSetupAwaiting = "" | "name" | "cwd";

export interface TopicSetupRow {
  chat_id: number;
  owner_user_id: number;
  message_thread_id: number;
  topic_name: string;
  model: "sol" | "luna" | "terra";
  reasoning_effort: "low" | "medium" | "high" | "xhigh";
  fast: number;
  cwd: string;
  awaiting: TopicSetupAwaiting;
  starter_message_id: number | null;
  last_icon_status: "" | "working" | "done" | "closed";
  idle_since: number;
  closed_session_id: string | null;
  closed_at: number | null;
  resting_message_id: number | null;
  updated_at: number;
}

const CALLBACK_REFERENCE_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const CALLBACKS_PER_OWNER_CAP = 1_024;
const CALLBACKS_GLOBAL_CAP = 4_096;
const MAX_CALLBACK_RECORD_BYTES = MAX_CALLBACK_PAYLOAD_BYTES + 1_024;
const TELEGRAM_UPDATE_RETENTION_MS = 48 * 60 * 60 * 1_000;
const MAX_THINKING_SUMMARIES = 32;
const MAX_THINKING_SUMMARY_CHARS = 1_000;
const MAX_THINKING_SECTION_CHARS = 12_000;

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
        seen_at INTEGER NOT NULL,
        completed_at INTEGER
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
        message_thread_id INTEGER NOT NULL DEFAULT 0,
        server_pid INTEGER NOT NULL,
        pane_id TEXT NOT NULL,
        pane_pid INTEGER NOT NULL,
        session_name TEXT NOT NULL,
        window_name TEXT NOT NULL,
        assistant_name TEXT NOT NULL DEFAULT 'Codex',
        cwd TEXT NOT NULL,
        attached_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, owner_user_id, message_thread_id)
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
        delivered_at INTEGER,
        queued_for_next_turn INTEGER NOT NULL DEFAULT 0
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
        status_kind TEXT NOT NULL DEFAULT 'state_working',
        tool_calls INTEGER NOT NULL DEFAULT 0,
        edited_files INTEGER NOT NULL DEFAULT 0,
        explored_things INTEGER NOT NULL DEFAULT 0,
        active_shells INTEGER NOT NULL DEFAULT 0,
        queued_messages INTEGER NOT NULL DEFAULT 0,
        reply_to_message_id INTEGER,
        started_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (
          chat_id, owner_user_id, server_pid, pane_id, pane_pid
        )
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
        PRIMARY KEY (
          chat_id, owner_user_id, server_pid, pane_id, pane_pid
        )
      );
      CREATE TABLE IF NOT EXISTS codex_final_deliveries (
        chat_id INTEGER NOT NULL,
        owner_user_id INTEGER NOT NULL,
        server_pid INTEGER NOT NULL,
        pane_id TEXT NOT NULL,
        pane_pid INTEGER NOT NULL,
        message_hash TEXT NOT NULL,
        delivered_at INTEGER NOT NULL,
        PRIMARY KEY (
          chat_id, owner_user_id, server_pid, pane_id, pane_pid
        )
      );
      CREATE TABLE IF NOT EXISTS codex_session_work (
        session_id TEXT PRIMARY KEY,
        active_ms INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS codex_turn_work (
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        active_ms INTEGER NOT NULL DEFAULT 0,
        recorded_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, turn_id)
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
      CREATE TABLE IF NOT EXISTS codex_thinking_sections (
        chat_id INTEGER NOT NULL,
        owner_user_id INTEGER NOT NULL,
        server_pid INTEGER NOT NULL,
        pane_id TEXT NOT NULL,
        pane_pid INTEGER NOT NULL,
        summaries_json TEXT NOT NULL DEFAULT '[]',
        omitted_count INTEGER NOT NULL DEFAULT 0,
        telegram_message_id INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        rendered_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (
          chat_id, owner_user_id, server_pid, pane_id, pane_pid
        )
      );
      CREATE TABLE IF NOT EXISTS codex_goals (
        chat_id INTEGER NOT NULL,
        owner_user_id INTEGER NOT NULL,
        message_thread_id INTEGER NOT NULL DEFAULT 0,
        thread_id TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL,
        token_budget INTEGER,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        time_used_seconds INTEGER NOT NULL DEFAULT 0,
        goal_created_at INTEGER NOT NULL,
        goal_updated_at INTEGER NOT NULL,
        observed_at INTEGER NOT NULL,
        awaiting_edit INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (chat_id, owner_user_id, message_thread_id)
      );
      CREATE INDEX IF NOT EXISTS codex_goals_thread_idx
        ON codex_goals(thread_id);
      CREATE TABLE IF NOT EXISTS codex_goal_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        owner_user_id INTEGER NOT NULL,
        message_thread_id INTEGER NOT NULL DEFAULT 0,
        thread_id TEXT NOT NULL,
        topic_name TEXT NOT NULL DEFAULT '',
        objective TEXT NOT NULL,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        time_used_seconds INTEGER NOT NULL DEFAULT 0,
        goal_created_at INTEGER NOT NULL,
        completed_at INTEGER NOT NULL,
        telegram_message_id INTEGER,
        UNIQUE(thread_id, goal_created_at)
      );
      CREATE INDEX IF NOT EXISTS codex_goal_history_chat_idx
        ON codex_goal_history(chat_id, completed_at DESC);
      CREATE TABLE IF NOT EXISTS nexus_dashboards (
        chat_id INTEGER PRIMARY KEY,
        owner_user_id INTEGER NOT NULL,
        message_thread_id INTEGER NOT NULL,
        dashboard_message_id INTEGER,
        render_signature TEXT NOT NULL DEFAULT '',
        rendered_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wizard_topics (
        chat_id INTEGER PRIMARY KEY,
        owner_user_id INTEGER NOT NULL,
        message_thread_id INTEGER NOT NULL,
        server_pid INTEGER,
        pane_id TEXT,
        pane_pid INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS topic_setups (
        chat_id INTEGER NOT NULL,
        owner_user_id INTEGER NOT NULL,
        message_thread_id INTEGER NOT NULL,
        topic_name TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT 'sol',
        reasoning_effort TEXT NOT NULL DEFAULT 'high',
        fast INTEGER NOT NULL DEFAULT 0,
        cwd TEXT NOT NULL,
        awaiting TEXT NOT NULL DEFAULT '',
        starter_message_id INTEGER,
        last_icon_status TEXT NOT NULL DEFAULT '',
        idle_since INTEGER NOT NULL DEFAULT 0,
        closed_session_id TEXT,
        closed_at INTEGER,
        resting_message_id INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, owner_user_id, message_thread_id)
      );
    `);
    this.migrateSeenUpdates();
    this.migrateCodexAttachments();
    this.migrateCodexPrompts();
    this.migrateCodexStatuses();
    this.migrateCodexTopicRouting();
    this.migrateTopicSetups();
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
    messageThreadId = 0,
  ): CodexAttachmentRow | null {
    return (
      (this.db.prepare(`
        SELECT * FROM codex_attachments
        WHERE chat_id = ? AND owner_user_id = ? AND message_thread_id = ?
      `).get(
        chatId,
        ownerUserId,
        messageThreadId,
      ) as CodexAttachmentRow | undefined) ?? null
    );
  }

  codexAttachmentForTarget(
    chatId: number,
    ownerUserId: number,
    target: CodexPaneIdentity,
  ): CodexAttachmentRow | null {
    return (
      (this.db.prepare(`
        SELECT * FROM codex_attachments
        WHERE chat_id = ? AND owner_user_id = ?
          AND server_pid = ? AND pane_id = ? AND pane_pid = ?
      `).get(
        chatId,
        ownerUserId,
        target.serverPid,
        target.paneId,
        target.panePid,
      ) as CodexAttachmentRow | undefined) ?? null
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

  codexAttachments(): CodexAttachmentRow[] {
    return this.db.prepare(`
      SELECT * FROM codex_attachments
      ORDER BY chat_id, owner_user_id, message_thread_id
    `).all() as unknown as CodexAttachmentRow[];
  }

  attachCodex(
    chatId: number,
    ownerUserId: number,
    pane: CodexPane,
    messageThreadId = 0,
  ): CodexAttachmentRow {
    this.db.prepare(`
      INSERT INTO codex_attachments (
        chat_id, owner_user_id, message_thread_id, server_pid, pane_id, pane_pid,
        session_name, window_name, assistant_name, cwd, attached_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id, owner_user_id, message_thread_id) DO UPDATE SET
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
      messageThreadId,
      pane.serverPid,
      pane.paneId,
      pane.panePid,
      pane.sessionName,
      pane.windowName,
      pane.assistantName ?? "Codex",
      pane.cwd,
      this.now(),
    );
    return this.codexAttachment(chatId, ownerUserId, messageThreadId)!;
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

  detachCodex(
    chatId: number,
    ownerUserId: number,
    messageThreadId = 0,
  ): boolean {
    const attachment = this.codexAttachment(
      chatId,
      ownerUserId,
      messageThreadId,
    );
    if (!attachment) return false;
    const detached = this.db.prepare(`
      DELETE FROM codex_attachments
      WHERE chat_id = ? AND owner_user_id = ? AND message_thread_id = ?
    `).run(chatId, ownerUserId, messageThreadId).changes > 0;
    if (detached) {
      this.db.prepare(`
        DELETE FROM codex_queued_prompts
        WHERE chat_id = ? AND owner_user_id = ?
          AND server_pid = ? AND pane_id = ? AND pane_pid = ?
      `).run(
        chatId,
        ownerUserId,
        attachment.server_pid,
        attachment.pane_id,
        attachment.pane_pid,
      );
      this.db.prepare(`
        DELETE FROM codex_queue_status_messages
        WHERE chat_id = ? AND owner_user_id = ?
          AND server_pid = ? AND pane_id = ? AND pane_pid = ?
      `).run(
        chatId,
        ownerUserId,
        attachment.server_pid,
        attachment.pane_id,
        attachment.pane_pid,
      );
      this.db.prepare(`
        DELETE FROM codex_thinking_sections
        WHERE chat_id = ? AND owner_user_id = ?
          AND server_pid = ? AND pane_id = ? AND pane_pid = ?
      `).run(
        chatId,
        ownerUserId,
        attachment.server_pid,
        attachment.pane_id,
        attachment.pane_pid,
      );
    }
    return detached;
  }

  recordCodexPrompt(
    chatId: number,
    ownerUserId: number,
    target: CodexPaneIdentity,
    telegramMessageId: number,
    queuedForNextTurn = false,
  ): void {
    this.db.prepare(`
      INSERT INTO codex_prompts (
        chat_id, owner_user_id, server_pid, pane_id, pane_pid,
        telegram_message_id, created_at, queued_for_next_turn
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM codex_prompts
        WHERE chat_id = ? AND owner_user_id = ?
          AND server_pid = ? AND pane_id = ? AND pane_pid = ?
          AND telegram_message_id = ?
      )
    `).run(
      chatId,
      ownerUserId,
      target.serverPid,
      target.paneId,
      target.panePid,
      telegramMessageId,
      this.now(),
      queuedForNextTurn ? 1 : 0,
      chatId,
      ownerUserId,
      target.serverPid,
      target.paneId,
      target.panePid,
      telegramMessageId,
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

  codexThinkingSection(
    chatId: number,
    ownerUserId: number,
    target: CodexPaneIdentity,
  ): CodexThinkingSectionRow | null {
    return (
      (this.db.prepare(`
        SELECT * FROM codex_thinking_sections
        WHERE chat_id = ? AND owner_user_id = ?
          AND server_pid = ? AND pane_id = ? AND pane_pid = ?
      `).get(
        chatId,
        ownerUserId,
        target.serverPid,
        target.paneId,
        target.panePid,
      ) as CodexThinkingSectionRow | undefined) ?? null
    );
  }

  appendCodexThinkingSummary(
    chatId: number,
    ownerUserId: number,
    target: CodexPaneIdentity,
    summary: string,
  ): CodexThinkingSectionRow {
    const normalized = summary
      .replace(/\u0000/gu, "�")
      .trim()
      .slice(0, MAX_THINKING_SUMMARY_CHARS);
    if (!normalized) {
      throw new Error("Thinking summary must not be empty");
    }
    const existing = this.codexThinkingSection(chatId, ownerUserId, target);
    const summaries = parseThinkingSummaries(existing?.summaries_json);
    let omittedCount = existing?.omitted_count ?? 0;
    if (summaries[summaries.length - 1] === normalized && existing) {
      return existing;
    }
    summaries.push(normalized);
    while (
      summaries.length > MAX_THINKING_SUMMARIES ||
      summaries.reduce((total, value) => total + value.length, 0) >
        MAX_THINKING_SECTION_CHARS
    ) {
      summaries.shift();
      omittedCount += 1;
    }
    const now = Math.max(
      this.now(),
      (existing?.updated_at ?? 0) + 1,
      (existing?.rendered_at ?? 0) + 1,
    );
    this.db.prepare(`
      INSERT INTO codex_thinking_sections (
        chat_id, owner_user_id, server_pid, pane_id, pane_pid,
        summaries_json, omitted_count, telegram_message_id,
        created_at, updated_at, rendered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0)
      ON CONFLICT(
        chat_id, owner_user_id, server_pid, pane_id, pane_pid
      ) DO UPDATE SET
        summaries_json = excluded.summaries_json,
        omitted_count = excluded.omitted_count,
        updated_at = excluded.updated_at
    `).run(
      chatId,
      ownerUserId,
      target.serverPid,
      target.paneId,
      target.panePid,
      JSON.stringify(summaries),
      omittedCount,
      now,
      now,
    );
    return this.codexThinkingSection(chatId, ownerUserId, target)!;
  }

  codexThinkingSectionsDue(
    updatedThrough: number,
  ): CodexThinkingSectionRow[] {
    return this.db.prepare(`
      SELECT * FROM codex_thinking_sections
      WHERE
        (
          telegram_message_id IS NULL
          AND created_at <= ?
        )
        OR
        (
          telegram_message_id IS NOT NULL
          AND updated_at > rendered_at
          AND rendered_at <= ?
        )
      ORDER BY created_at, chat_id, owner_user_id
      LIMIT 100
    `).all(
      updatedThrough,
      updatedThrough,
    ) as unknown as CodexThinkingSectionRow[];
  }

  markCodexThinkingSectionRendered(
    chatId: number,
    ownerUserId: number,
    target: CodexPaneIdentity,
    telegramMessageId: number,
  ): CodexThinkingSectionRow | null {
    const existing = this.codexThinkingSection(chatId, ownerUserId, target);
    if (!existing) return null;
    this.db.prepare(`
      UPDATE codex_thinking_sections
      SET telegram_message_id = ?, rendered_at = ?
      WHERE chat_id = ? AND owner_user_id = ?
        AND server_pid = ? AND pane_id = ? AND pane_pid = ?
    `).run(
      telegramMessageId,
      Math.max(this.now(), existing.updated_at),
      chatId,
      ownerUserId,
      target.serverPid,
      target.paneId,
      target.panePid,
    );
    return this.codexThinkingSection(chatId, ownerUserId, target);
  }

  clearCodexThinkingSection(
    chatId: number,
    ownerUserId: number,
    target: CodexPaneIdentity,
  ): CodexThinkingSectionRow | null {
    const existing = this.codexThinkingSection(chatId, ownerUserId, target);
    if (!existing) return null;
    this.db.prepare(`
      DELETE FROM codex_thinking_sections
      WHERE chat_id = ? AND owner_user_id = ?
        AND server_pid = ? AND pane_id = ? AND pane_pid = ?
    `).run(
      chatId,
      ownerUserId,
      target.serverPid,
      target.paneId,
      target.panePid,
    );
    return existing;
  }

  // ── Native Codex goals ────────────────────────────────
  codexGoal(
    chatId: number,
    ownerUserId: number,
    messageThreadId = 0,
  ): CodexGoalRow | null {
    return (
      (this.db.prepare(`
        SELECT * FROM codex_goals
        WHERE chat_id = ? AND owner_user_id = ? AND message_thread_id = ?
      `).get(
        chatId,
        ownerUserId,
        messageThreadId,
      ) as CodexGoalRow | undefined) ?? null
    );
  }

  codexGoalsForChat(chatId: number): CodexGoalRow[] {
    return this.db.prepare(`
      SELECT * FROM codex_goals
      WHERE chat_id = ?
      ORDER BY
        CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
        goal_updated_at DESC
    `).all(chatId) as unknown as CodexGoalRow[];
  }

  hasActiveCodexGoal(
    chatId: number,
    ownerUserId: number,
    messageThreadId = 0,
  ): boolean {
    return this.db.prepare(`
      SELECT 1 FROM codex_goals
      WHERE chat_id = ? AND owner_user_id = ? AND message_thread_id = ?
        AND status = 'active'
    `).get(chatId, ownerUserId, messageThreadId) !== undefined;
  }

  observeCodexGoal(
    chatId: number,
    ownerUserId: number,
    messageThreadId: number,
    goal: CodexThreadGoal | null,
  ): CodexGoalRow | null {
    const existing = this.codexGoal(chatId, ownerUserId, messageThreadId);
    if (!goal) {
      this.db.prepare(`
        DELETE FROM codex_goals
        WHERE chat_id = ? AND owner_user_id = ? AND message_thread_id = ?
      `).run(chatId, ownerUserId, messageThreadId);
      return null;
    }
    const isNewIdentity =
      existing?.thread_id !== goal.threadId ||
      existing?.goal_created_at !== goal.createdAt;
    if (
      goal.status === "complete" &&
      (isNewIdentity || existing?.status !== "complete")
    ) {
      const setup = this.topicSetup(chatId, ownerUserId, messageThreadId);
      this.db.prepare(`
        INSERT OR IGNORE INTO codex_goal_history (
          chat_id, owner_user_id, message_thread_id, thread_id, topic_name,
          objective, tokens_used, time_used_seconds, goal_created_at,
          completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        chatId,
        ownerUserId,
        messageThreadId,
        goal.threadId,
        setup?.topic_name ?? "",
        goal.objective,
        goal.tokensUsed,
        goal.timeUsedSeconds,
        goal.createdAt,
        this.now(),
      );
    }
    this.db.prepare(`
      INSERT INTO codex_goals (
        chat_id, owner_user_id, message_thread_id, thread_id, objective,
        status, token_budget, tokens_used, time_used_seconds, goal_created_at,
        goal_updated_at, observed_at, awaiting_edit
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id, owner_user_id, message_thread_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        objective = excluded.objective,
        status = excluded.status,
        token_budget = excluded.token_budget,
        tokens_used = excluded.tokens_used,
        time_used_seconds = excluded.time_used_seconds,
        goal_created_at = excluded.goal_created_at,
        goal_updated_at = excluded.goal_updated_at,
        observed_at = excluded.observed_at,
        awaiting_edit = CASE
          WHEN codex_goals.thread_id = excluded.thread_id
            AND codex_goals.goal_created_at = excluded.goal_created_at
          THEN codex_goals.awaiting_edit
          ELSE 0
        END
    `).run(
      chatId,
      ownerUserId,
      messageThreadId,
      goal.threadId,
      goal.objective,
      goal.status,
      goal.tokenBudget,
      goal.tokensUsed,
      goal.timeUsedSeconds,
      goal.createdAt,
      goal.updatedAt,
      this.now(),
      isNewIdentity ? 0 : existing?.awaiting_edit ?? 0,
    );
    return this.codexGoal(chatId, ownerUserId, messageThreadId);
  }

  setCodexGoalAwaitingEdit(
    chatId: number,
    ownerUserId: number,
    messageThreadId: number,
    awaiting: boolean,
  ): void {
    this.db.prepare(`
      UPDATE codex_goals
      SET awaiting_edit = ?, observed_at = ?
      WHERE chat_id = ? AND owner_user_id = ? AND message_thread_id = ?
    `).run(
      awaiting ? 1 : 0,
      this.now(),
      chatId,
      ownerUserId,
      messageThreadId,
    );
  }

  recentCompletedCodexGoals(
    chatId: number,
    limit = 10,
  ): CodexGoalHistoryRow[] {
    const safeLimit = Number.isSafeInteger(limit)
      ? Math.max(1, Math.min(50, limit))
      : 10;
    return this.db.prepare(`
      SELECT * FROM codex_goal_history
      WHERE chat_id = ?
      ORDER BY completed_at DESC, id DESC
      LIMIT ?
    `).all(chatId, safeLimit) as unknown as CodexGoalHistoryRow[];
  }

  pendingCodexGoalCompletions(limit = 20): CodexGoalHistoryRow[] {
    const safeLimit = Number.isSafeInteger(limit)
      ? Math.max(1, Math.min(100, limit))
      : 20;
    return this.db.prepare(`
      SELECT * FROM codex_goal_history
      WHERE telegram_message_id IS NULL
      ORDER BY completed_at, id
      LIMIT ?
    `).all(safeLimit) as unknown as CodexGoalHistoryRow[];
  }

  markCodexGoalCompletionAnnounced(
    id: number,
    telegramMessageId: number,
  ): void {
    this.db.prepare(`
      UPDATE codex_goal_history
      SET telegram_message_id = ?
      WHERE id = ? AND telegram_message_id IS NULL
    `).run(telegramMessageId, id);
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
    snapshot?: Partial<CodexStatusSnapshot>,
  ): void {
    const existing = this.codexStatus(chatId, ownerUserId, target);
    const statusKind = snapshot?.statusKind ??
      existing?.status_kind ??
      "state_working";
    const toolCalls = nonNegativeCount(
      snapshot?.toolCalls ?? existing?.tool_calls ?? 0,
    );
    const editedFiles = nonNegativeCount(
      snapshot?.editedFiles ?? existing?.edited_files ?? 0,
    );
    const exploredThings = nonNegativeCount(
      snapshot?.exploredThings ?? existing?.explored_things ?? 0,
    );
    const activeShells = nonNegativeCount(
      snapshot?.activeShells ?? existing?.active_shells ?? 0,
    );
    const queuedMessages = nonNegativeCount(
      snapshot?.queuedMessages ?? existing?.queued_messages ?? 0,
    );
    const replyToMessageId = positiveIntegerOrNull(
      snapshot?.replyToMessageId ?? existing?.reply_to_message_id ?? null,
    );
    const startedAt = positiveIntegerOrNull(
      snapshot?.startedAt ?? existing?.started_at ?? this.now(),
    ) ?? this.now();
    this.db.prepare(`
      INSERT INTO codex_status_messages (
        chat_id, owner_user_id, server_pid, pane_id, pane_pid,
        telegram_message_id, status_kind, tool_calls, edited_files,
        explored_things, active_shells, queued_messages, reply_to_message_id,
        started_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(
        chat_id, owner_user_id, server_pid, pane_id, pane_pid
      ) DO UPDATE SET
        telegram_message_id = excluded.telegram_message_id,
        status_kind = excluded.status_kind,
        tool_calls = excluded.tool_calls,
        edited_files = excluded.edited_files,
        explored_things = excluded.explored_things,
        active_shells = excluded.active_shells,
        queued_messages = excluded.queued_messages,
        reply_to_message_id = excluded.reply_to_message_id,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at
    `).run(
      chatId,
      ownerUserId,
      target.serverPid,
      target.paneId,
      target.panePid,
      telegramMessageId,
      statusKind,
      toolCalls,
      editedFiles,
      exploredThings,
      activeShells,
      queuedMessages,
      replyToMessageId,
      startedAt,
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
      ON CONFLICT(
        chat_id, owner_user_id, server_pid, pane_id, pane_pid
      ) DO UPDATE SET
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

  addCodexSessionWork(
    sessionId: string,
    turnId: string,
    elapsedMs: number,
  ): number {
    const normalizedSessionId = sessionId.trim().slice(0, 200);
    const normalizedTurnId = turnId.trim().slice(0, 300);
    if (!normalizedSessionId || !normalizedTurnId) return 0;
    const safeElapsed = Math.min(
      24 * 60 * 60 * 1_000,
      nonNegativeCount(Math.round(elapsedMs)),
    );
    this.db.prepare(`
      INSERT OR IGNORE INTO codex_turn_work (
        session_id, turn_id, active_ms, recorded_at
      ) VALUES (?, ?, ?, ?)
    `).run(
      normalizedSessionId,
      normalizedTurnId,
      safeElapsed,
      this.now(),
    );
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(active_ms), 0) AS active_ms
      FROM codex_turn_work WHERE session_id = ?
    `).get(normalizedSessionId) as { active_ms: number } | undefined;
    return Math.max(0, row?.active_ms ?? 0);
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
      ON CONFLICT(
        chat_id, owner_user_id, server_pid, pane_id, pane_pid
      ) DO UPDATE SET
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
  /** Returns true when this update id is not completed or already in flight. */
  claimTelegramUpdate(updateId: number): boolean {
    const result = this.db
      .prepare(`
        INSERT OR IGNORE INTO seen_updates (
          update_id, seen_at, completed_at
        ) VALUES (?, ?, NULL)
      `)
      .run(updateId, this.now());
    this.db
      .prepare(`DELETE FROM seen_updates WHERE seen_at < ?`)
      .run(this.now() - TELEGRAM_UPDATE_RETENTION_MS);
    return result.changes > 0;
  }

  completeTelegramUpdate(updateId: number): void {
    this.db.prepare(`
      UPDATE seen_updates
      SET completed_at = ?
      WHERE update_id = ? AND completed_at IS NULL
    `).run(this.now(), updateId);
  }

  /** Release a failed in-flight update so the poller can retry it. */
  releaseTelegramUpdate(updateId: number): void {
    this.db.prepare(`DELETE FROM seen_updates WHERE update_id = ?`).run(updateId);
  }

  // ── Forum overview dashboard ─────────────────────────
  overviewDashboard(chatId: number): OverviewDashboardRow | null {
    return (
      (this.db.prepare(`
        SELECT * FROM nexus_dashboards WHERE chat_id = ?
      `).get(chatId) as OverviewDashboardRow | undefined) ?? null
    );
  }

  overviewDashboards(): OverviewDashboardRow[] {
    return this.db.prepare(`
      SELECT * FROM nexus_dashboards ORDER BY updated_at
    `).all() as unknown as OverviewDashboardRow[];
  }

  isOverviewChat(chatId: number): boolean {
    return this.overviewDashboard(chatId) !== null;
  }

  registerOverview(
    chatId: number,
    ownerUserId: number,
    messageThreadId: number,
  ): OverviewDashboardRow {
    this.db.prepare(`
      INSERT INTO nexus_dashboards (
        chat_id, owner_user_id, message_thread_id, updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        owner_user_id = excluded.owner_user_id,
        message_thread_id = excluded.message_thread_id,
        updated_at = excluded.updated_at
    `).run(chatId, ownerUserId, messageThreadId, this.now());
    return this.overviewDashboard(chatId)!;
  }

  setOverviewDashboardMessage(
    chatId: number,
    messageId: number,
    renderSignature: string,
  ): void {
    this.db.prepare(`
      UPDATE nexus_dashboards
      SET dashboard_message_id = ?, render_signature = ?,
          rendered_at = ?, updated_at = ?
      WHERE chat_id = ?
    `).run(messageId, renderSignature, this.now(), this.now(), chatId);
  }

  // ── Forum manager topic ───────────────────────────────
  managerTopic(chatId: number): ManagerTopicRow | null {
    return (
      (this.db.prepare(`
        SELECT * FROM wizard_topics WHERE chat_id = ?
      `).get(chatId) as ManagerTopicRow | undefined) ?? null
    );
  }

  isManagerChat(chatId: number): boolean {
    return this.managerTopic(chatId) !== null;
  }

  registerManagerTopic(
    chatId: number,
    ownerUserId: number,
    messageThreadId: number,
  ): ManagerTopicRow {
    this.db.prepare(`
      INSERT INTO wizard_topics (
        chat_id, owner_user_id, message_thread_id, updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        owner_user_id = excluded.owner_user_id,
        message_thread_id = excluded.message_thread_id,
        updated_at = excluded.updated_at
    `).run(chatId, ownerUserId, messageThreadId, this.now());
    return this.managerTopic(chatId)!;
  }

  setManagerTarget(
    chatId: number,
    target: CodexPaneIdentity,
  ): void {
    this.db.prepare(`
      UPDATE wizard_topics
      SET server_pid = ?, pane_id = ?, pane_pid = ?, updated_at = ?
      WHERE chat_id = ?
    `).run(
      target.serverPid,
      target.paneId,
      target.panePid,
      this.now(),
      chatId,
    );
  }

  // ── Forum topic session setup ─────────────────────────
  topicSetup(
    chatId: number,
    ownerUserId: number,
    messageThreadId: number,
  ): TopicSetupRow | null {
    return (
      (this.db.prepare(`
        SELECT * FROM topic_setups
        WHERE chat_id = ? AND owner_user_id = ? AND message_thread_id = ?
      `).get(
        chatId,
        ownerUserId,
        messageThreadId,
      ) as TopicSetupRow | undefined) ?? null
    );
  }

  topicSetups(): TopicSetupRow[] {
    return this.db.prepare(`
      SELECT * FROM topic_setups
      ORDER BY chat_id, owner_user_id, message_thread_id
    `).all() as unknown as TopicSetupRow[];
  }

  rememberTopic(
    chatId: number,
    ownerUserId: number,
    messageThreadId: number,
    topicName: string,
    defaultCwd: string,
    defaults: {
      readonly model: "sol" | "luna" | "terra";
      readonly reasoningEffort: "low" | "medium" | "high" | "xhigh";
      readonly fast: boolean;
    } = {
      model: "sol",
      reasoningEffort: "high",
      fast: false,
    },
  ): TopicSetupRow {
    this.db.prepare(`
      INSERT INTO topic_setups (
        chat_id, owner_user_id, message_thread_id, topic_name,
        model, reasoning_effort, fast, cwd, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id, owner_user_id, message_thread_id) DO UPDATE SET
        topic_name = excluded.topic_name,
        last_icon_status = '',
        updated_at = excluded.updated_at
    `).run(
      chatId,
      ownerUserId,
      messageThreadId,
      topicName,
      defaults.model,
      defaults.reasoningEffort,
      defaults.fast ? 1 : 0,
      defaultCwd,
      this.now(),
    );
    return this.topicSetup(chatId, ownerUserId, messageThreadId)!;
  }

  ensureTopicSetup(
    chatId: number,
    ownerUserId: number,
    messageThreadId: number,
    fallbackName: string,
    defaultCwd: string,
    defaults?: {
      readonly model: "sol" | "luna" | "terra";
      readonly reasoningEffort: "low" | "medium" | "high" | "xhigh";
      readonly fast: boolean;
    },
  ): TopicSetupRow {
    const existing = this.topicSetup(chatId, ownerUserId, messageThreadId);
    return existing ?? this.rememberTopic(
      chatId,
      ownerUserId,
      messageThreadId,
      fallbackName,
      defaultCwd,
      defaults,
    );
  }

  updateTopicSetup(
    chatId: number,
    ownerUserId: number,
    messageThreadId: number,
    updates: Partial<Pick<
      TopicSetupRow,
      | "topic_name"
      | "model"
      | "reasoning_effort"
      | "fast"
      | "cwd"
      | "awaiting"
      | "starter_message_id"
      | "last_icon_status"
      | "idle_since"
      | "closed_session_id"
      | "closed_at"
      | "resting_message_id"
    >>,
  ): TopicSetupRow | null {
    const allowed = [
      "topic_name",
      "model",
      "reasoning_effort",
      "fast",
      "cwd",
      "awaiting",
      "starter_message_id",
      "last_icon_status",
      "idle_since",
      "closed_session_id",
      "closed_at",
      "resting_message_id",
    ] as const;
    const entries = allowed.flatMap((key) =>
      updates[key] === undefined ? [] : [[key, updates[key]] as const]
    );
    if (entries.length === 0) {
      return this.topicSetup(chatId, ownerUserId, messageThreadId);
    }
    const assignments = entries.map(([key]) => `${key} = ?`).join(", ");
    this.db.prepare(`
      UPDATE topic_setups
      SET ${assignments}, updated_at = ?
      WHERE chat_id = ? AND owner_user_id = ? AND message_thread_id = ?
    `).run(
      ...entries.map(([, value]) => value),
      this.now(),
      chatId,
      ownerUserId,
      messageThreadId,
    );
    return this.topicSetup(chatId, ownerUserId, messageThreadId);
  }

  // ── Callback references ───────────────────────────────
  callbackStore(): CallbackReferenceStore {
    return new SqliteCallbackStore(this.db, this.now);
  }

  private migrateSeenUpdates(): void {
    const columns = new Set(
      (this.db.prepare(`PRAGMA table_info(seen_updates)`).all() as unknown as
        Array<{ name: string }>).map((column) => column.name),
    );
    if (!columns.has("completed_at")) {
      this.db.exec(`
        ALTER TABLE seen_updates ADD COLUMN completed_at INTEGER;
        UPDATE seen_updates SET completed_at = seen_at;
      `);
    }
    // A row without completed_at belonged to a process that stopped before the
    // poller advanced its durable offset. Telegram will replay that update.
    this.db.exec(`DELETE FROM seen_updates WHERE completed_at IS NULL`);
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

  private migrateCodexPrompts(): void {
    const columns = new Set(
      (this.db.prepare(`PRAGMA table_info(codex_prompts)`).all() as unknown as
        Array<{ name: string }>).map((column) => column.name),
    );
    if (!columns.has("queued_for_next_turn")) {
      this.db.exec(`
        ALTER TABLE codex_prompts
        ADD COLUMN queued_for_next_turn INTEGER NOT NULL DEFAULT 0
      `);
    }
  }

  private migrateTopicSetups(): void {
    const columns = new Set(
      (this.db.prepare(`PRAGMA table_info(topic_setups)`).all() as unknown as
        Array<{ name: string }>).map((column) => column.name),
    );
    if (!columns.has("last_icon_status")) {
      this.db.exec(`
        ALTER TABLE topic_setups
        ADD COLUMN last_icon_status TEXT NOT NULL DEFAULT ''
      `);
    }
    const additions = [
      ["idle_since", "INTEGER NOT NULL DEFAULT 0"],
      ["closed_session_id", "TEXT"],
      ["closed_at", "INTEGER"],
      ["resting_message_id", "INTEGER"],
    ] as const;
    for (const [name, definition] of additions) {
      if (!columns.has(name)) {
        this.db.exec(`ALTER TABLE topic_setups ADD COLUMN ${name} ${definition}`);
      }
    }
  }

  private migrateCodexTopicRouting(): void {
    const primaryKey = (table: string): string[] =>
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as
        Array<{ name: string; pk: number }>)
        .filter((column) => column.pk > 0)
        .sort((left, right) => left.pk - right.pk)
        .map((column) => column.name);
    const attachmentColumns = new Set(
      (this.db.prepare(`PRAGMA table_info(codex_attachments)`).all() as unknown as
        Array<{ name: string }>).map((column) => column.name),
    );
    const targetKey = [
      "chat_id",
      "owner_user_id",
      "server_pid",
      "pane_id",
      "pane_pid",
    ];
    const attachmentsNeedMigration =
      !attachmentColumns.has("message_thread_id") ||
      primaryKey("codex_attachments").join(",") !==
        "chat_id,owner_user_id,message_thread_id";
    const statusNeedsMigration =
      primaryKey("codex_status_messages").join(",") !== targetKey.join(",");
    const queueNeedsMigration =
      primaryKey("codex_queue_status_messages").join(",") !==
        targetKey.join(",");
    const finalNeedsMigration =
      primaryKey("codex_final_deliveries").join(",") !== targetKey.join(",");
    if (
      !attachmentsNeedMigration &&
      !statusNeedsMigration &&
      !queueNeedsMigration &&
      !finalNeedsMigration
    ) return;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (attachmentsNeedMigration) {
        this.db.exec(`
          DROP INDEX IF EXISTS codex_attachments_target_idx;
          ALTER TABLE codex_attachments RENAME TO codex_attachments_legacy;
          CREATE TABLE codex_attachments (
            chat_id INTEGER NOT NULL,
            owner_user_id INTEGER NOT NULL,
            message_thread_id INTEGER NOT NULL DEFAULT 0,
            server_pid INTEGER NOT NULL,
            pane_id TEXT NOT NULL,
            pane_pid INTEGER NOT NULL,
            session_name TEXT NOT NULL,
            window_name TEXT NOT NULL,
            assistant_name TEXT NOT NULL DEFAULT 'Codex',
            cwd TEXT NOT NULL,
            attached_at INTEGER NOT NULL,
            PRIMARY KEY (chat_id, owner_user_id, message_thread_id)
          );
          INSERT INTO codex_attachments (
            chat_id, owner_user_id, message_thread_id, server_pid, pane_id,
            pane_pid, session_name, window_name, assistant_name, cwd, attached_at
          )
          SELECT
            chat_id, owner_user_id, 0, server_pid, pane_id, pane_pid,
            session_name, window_name, assistant_name, cwd, attached_at
          FROM codex_attachments_legacy;
          DROP TABLE codex_attachments_legacy;
          CREATE INDEX codex_attachments_target_idx
            ON codex_attachments(server_pid, pane_id, pane_pid);
        `);
      }
      if (statusNeedsMigration) {
        this.db.exec(`
          ALTER TABLE codex_status_messages
            RENAME TO codex_status_messages_legacy;
          CREATE TABLE codex_status_messages (
            chat_id INTEGER NOT NULL,
            owner_user_id INTEGER NOT NULL,
            server_pid INTEGER NOT NULL,
            pane_id TEXT NOT NULL,
            pane_pid INTEGER NOT NULL,
            telegram_message_id INTEGER NOT NULL,
            status_kind TEXT NOT NULL DEFAULT 'state_working',
            tool_calls INTEGER NOT NULL DEFAULT 0,
            edited_files INTEGER NOT NULL DEFAULT 0,
            explored_things INTEGER NOT NULL DEFAULT 0,
            active_shells INTEGER NOT NULL DEFAULT 0,
            queued_messages INTEGER NOT NULL DEFAULT 0,
            reply_to_message_id INTEGER,
            started_at INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (
              chat_id, owner_user_id, server_pid, pane_id, pane_pid
            )
          );
          INSERT INTO codex_status_messages (
            chat_id, owner_user_id, server_pid, pane_id, pane_pid,
            telegram_message_id, status_kind, tool_calls, edited_files,
            explored_things, active_shells, queued_messages,
            reply_to_message_id, started_at, updated_at
          )
          SELECT
            chat_id, owner_user_id, server_pid, pane_id, pane_pid,
            telegram_message_id, status_kind, tool_calls, edited_files,
            explored_things, active_shells, queued_messages,
            reply_to_message_id, started_at, updated_at
          FROM codex_status_messages_legacy;
          DROP TABLE codex_status_messages_legacy;
        `);
      }
      if (queueNeedsMigration) {
        this.db.exec(`
          ALTER TABLE codex_queue_status_messages
            RENAME TO codex_queue_status_messages_legacy;
          CREATE TABLE codex_queue_status_messages (
            chat_id INTEGER NOT NULL,
            owner_user_id INTEGER NOT NULL,
            server_pid INTEGER NOT NULL,
            pane_id TEXT NOT NULL,
            pane_pid INTEGER NOT NULL,
            telegram_message_id INTEGER NOT NULL,
            message_count INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (
              chat_id, owner_user_id, server_pid, pane_id, pane_pid
            )
          );
          INSERT INTO codex_queue_status_messages (
            chat_id, owner_user_id, server_pid, pane_id, pane_pid,
            telegram_message_id, message_count, updated_at
          )
          SELECT
            chat_id, owner_user_id, server_pid, pane_id, pane_pid,
            telegram_message_id, message_count, updated_at
          FROM codex_queue_status_messages_legacy;
          DROP TABLE codex_queue_status_messages_legacy;
        `);
      }
      if (finalNeedsMigration) {
        this.db.exec(`
          ALTER TABLE codex_final_deliveries
            RENAME TO codex_final_deliveries_legacy;
          CREATE TABLE codex_final_deliveries (
            chat_id INTEGER NOT NULL,
            owner_user_id INTEGER NOT NULL,
            server_pid INTEGER NOT NULL,
            pane_id TEXT NOT NULL,
            pane_pid INTEGER NOT NULL,
            message_hash TEXT NOT NULL,
            delivered_at INTEGER NOT NULL,
            PRIMARY KEY (
              chat_id, owner_user_id, server_pid, pane_id, pane_pid
            )
          );
          INSERT INTO codex_final_deliveries (
            chat_id, owner_user_id, server_pid, pane_id, pane_pid,
            message_hash, delivered_at
          )
          SELECT
            chat_id, owner_user_id, server_pid, pane_id, pane_pid,
            message_hash, delivered_at
          FROM codex_final_deliveries_legacy;
          DROP TABLE codex_final_deliveries_legacy;
        `);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private migrateCodexStatuses(): void {
    const columns = new Set(
      (this.db.prepare(`PRAGMA table_info(codex_status_messages)`).all() as
        unknown as Array<{ name: string }>).map((column) => column.name),
    );
    const additions = [
      ["status_kind", "TEXT NOT NULL DEFAULT 'state_working'"],
      ["tool_calls", "INTEGER NOT NULL DEFAULT 0"],
      ["edited_files", "INTEGER NOT NULL DEFAULT 0"],
      ["explored_things", "INTEGER NOT NULL DEFAULT 0"],
      ["active_shells", "INTEGER NOT NULL DEFAULT 0"],
      ["queued_messages", "INTEGER NOT NULL DEFAULT 0"],
      ["reply_to_message_id", "INTEGER"],
      ["started_at", "INTEGER NOT NULL DEFAULT 0"],
    ] as const;
    for (const [name, definition] of additions) {
      if (!columns.has(name)) {
        this.db.exec(
          `ALTER TABLE codex_status_messages ADD COLUMN ${name} ${definition}`,
        );
      }
    }
  }
}

function nonNegativeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function positiveIntegerOrNull(value: number | null): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Number(value)
    : null;
}

export function parseThinkingSummaries(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0,
      ).slice(-MAX_THINKING_SUMMARIES)
      : [];
  } catch {
    return [];
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
