import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface ArtifactRoute {
  readonly chatId: number;
  readonly ownerUserId: number;
  readonly messageThreadId: number;
  readonly sessionId: string;
}

export interface ArtifactInput {
  readonly title: string;
  readonly kind: string;
  readonly url?: string;
  readonly previewUrl?: string;
  readonly telegramMessageId?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ArtifactRecord {
  readonly id: string;
  readonly shelfId: string;
  readonly title: string;
  readonly kind: string;
  readonly url: string | null;
  readonly previewUrl: string | null;
  readonly telegramMessageId: number | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
}

export interface ArtifactShelf {
  readonly id: string;
  readonly route: ArtifactRoute;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly artifacts: readonly ArtifactRecord[];
}

interface ShelfRow {
  id: string;
  chat_id: number;
  owner_user_id: number;
  message_thread_id: number;
  session_id: string;
  created_at: number;
  updated_at: number;
}

interface ArtifactRow {
  id: string;
  shelf_id: string;
  title: string;
  kind: string;
  url: string | null;
  preview_url: string | null;
  telegram_message_id: number | null;
  metadata_json: string;
  created_at: number;
}

export class ArtifactRegistry {
  private readonly database: DatabaseSync;

  constructor(
    databasePath: string,
    private readonly now: () => number = Date.now,
  ) {
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS artifact_shelves (
        id TEXT PRIMARY KEY,
        chat_id INTEGER NOT NULL,
        owner_user_id INTEGER NOT NULL,
        message_thread_id INTEGER NOT NULL DEFAULT 0,
        session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(chat_id, owner_user_id, message_thread_id, session_id)
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        shelf_id TEXT NOT NULL REFERENCES artifact_shelves(id)
          ON DELETE CASCADE,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        url TEXT,
        preview_url TEXT,
        telegram_message_id INTEGER,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS artifacts_shelf_idx
        ON artifacts(shelf_id, created_at, id);
    `);
  }

  close(): void {
    this.database.close();
  }

  shelfForRoute(route: ArtifactRoute, create = false): ArtifactShelf | null {
    let row = this.database.prepare(`
      SELECT * FROM artifact_shelves
      WHERE chat_id = ? AND owner_user_id = ? AND message_thread_id = ?
        AND session_id = ?
    `).get(
      route.chatId,
      route.ownerUserId,
      route.messageThreadId,
      route.sessionId,
    ) as ShelfRow | undefined;
    if (!row && create) {
      const timestamp = this.now();
      const id = randomBytes(24).toString("base64url");
      this.database.prepare(`
        INSERT INTO artifact_shelves (
          id, chat_id, owner_user_id, message_thread_id, session_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        route.chatId,
        route.ownerUserId,
        route.messageThreadId,
        route.sessionId,
        timestamp,
        timestamp,
      );
      row = this.database.prepare(
        "SELECT * FROM artifact_shelves WHERE id = ?",
      ).get(id) as unknown as ShelfRow;
    }
    return row ? this.hydrateShelf(row) : null;
  }

  add(route: ArtifactRoute, input: ArtifactInput): ArtifactShelf {
    const title = normalizeLabel(input.title, "title", 240);
    const kind = normalizeLabel(input.kind, "kind", 80);
    const url = input.url === undefined
      ? null
      : normalizeArtifactUrl(input.url, "url");
    const previewUrl = input.previewUrl === undefined
      ? null
      : normalizeArtifactUrl(input.previewUrl, "preview URL");
    if (
      input.telegramMessageId !== undefined &&
      (!Number.isSafeInteger(input.telegramMessageId) ||
        input.telegramMessageId < 1)
    ) {
      throw new Error("telegram message id is invalid");
    }
    const metadata = normalizeMetadata(input.metadata ?? {});
    const shelf = this.shelfForRoute(route, true)!;
    const timestamp = this.now();
    this.database.prepare(`
      INSERT INTO artifacts (
        id, shelf_id, title, kind, url, preview_url, telegram_message_id,
        metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      shelf.id,
      title,
      kind,
      url,
      previewUrl,
      input.telegramMessageId ?? null,
      JSON.stringify(metadata),
      timestamp,
    );
    this.database.prepare(
      "UPDATE artifact_shelves SET updated_at = ? WHERE id = ?",
    ).run(timestamp, shelf.id);
    return this.shelfById(shelf.id)!;
  }

  shelfById(id: string): ArtifactShelf | null {
    const row = this.database.prepare(
      "SELECT * FROM artifact_shelves WHERE id = ?",
    ).get(id) as ShelfRow | undefined;
    return row ? this.hydrateShelf(row) : null;
  }

  private hydrateShelf(row: ShelfRow): ArtifactShelf {
    const artifacts = this.database.prepare(`
      SELECT * FROM artifacts
      WHERE shelf_id = ?
      ORDER BY created_at, id
    `).all(row.id) as unknown as ArtifactRow[];
    return {
      id: row.id,
      route: {
        chatId: row.chat_id,
        ownerUserId: row.owner_user_id,
        messageThreadId: row.message_thread_id,
        sessionId: row.session_id,
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      artifacts: artifacts.map(hydrateArtifact),
    };
  }
}

export function artifactManifest(shelf: ArtifactShelf): {
  readonly version: 1;
  readonly shelf: {
    readonly id: string;
    readonly updatedAt: number;
  };
  readonly artifacts: readonly {
    readonly id: string;
    readonly title: string;
    readonly kind: string;
    readonly url?: string;
    readonly previewUrl?: string;
    readonly telegramMessageId?: number;
    readonly metadata: Readonly<Record<string, unknown>>;
    readonly createdAt: number;
  }[];
} {
  return {
    version: 1,
    shelf: {
      id: shelf.id,
      updatedAt: shelf.updatedAt,
    },
    artifacts: shelf.artifacts.map((artifact) => ({
      id: artifact.id,
      title: artifact.title,
      kind: artifact.kind,
      ...(artifact.url ? { url: artifact.url } : {}),
      ...(artifact.previewUrl ? { previewUrl: artifact.previewUrl } : {}),
      ...(artifact.telegramMessageId
        ? { telegramMessageId: artifact.telegramMessageId }
        : {}),
      metadata: artifact.metadata,
      createdAt: artifact.createdAt,
    })),
  };
}

export async function publishArtifactShelf(
  shelf: ArtifactShelf,
  options: {
    readonly apiUrl: string;
    readonly apiToken: string;
    readonly fetchImpl?: typeof fetch;
  },
): Promise<{
  readonly ok: true;
  readonly shelfUrl?: string;
  readonly launchUrl?: string;
}> {
  const apiUrl = normalizeArtifactUrl(options.apiUrl, "artifact API URL");
  const apiToken = options.apiToken.trim();
  if (!apiToken || apiToken.length > 4_096) {
    throw new Error("artifact API token is unavailable or invalid");
  }
  const response = await (options.fetchImpl ?? fetch)(
    new URL(`v1/shelves/${encodeURIComponent(shelf.id)}`, ensureSlash(apiUrl)),
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(artifactManifest(shelf)),
      signal: AbortSignal.timeout(15_000),
    },
  );
  const body = await response.json().catch(() => null) as {
    ok?: boolean;
    shelfUrl?: unknown;
    launchUrl?: unknown;
    error?: unknown;
  } | null;
  if (!response.ok || body?.ok !== true) {
    const detail = typeof body?.error === "string"
      ? body.error.slice(0, 300)
      : `HTTP ${response.status}`;
    throw new Error(`artifact publisher rejected the manifest: ${detail}`);
  }
  return {
    ok: true,
    ...(typeof body.shelfUrl === "string"
      ? { shelfUrl: normalizeArtifactUrl(body.shelfUrl, "shelf URL") }
      : {}),
    ...(typeof body.launchUrl === "string"
      ? { launchUrl: normalizeArtifactUrl(body.launchUrl, "launch URL") }
      : {}),
  };
}

function hydrateArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id,
    shelfId: row.shelf_id,
    title: row.title,
    kind: row.kind,
    url: row.url,
    previewUrl: row.preview_url,
    telegramMessageId: row.telegram_message_id,
    metadata: parseMetadata(row.metadata_json),
    createdAt: row.created_at,
  };
}

function normalizeLabel(value: string, label: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f]/u.test(normalized)) {
    throw new Error(`artifact ${label} is invalid`);
  }
  return normalized;
}

function normalizeArtifactUrl(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${label} must use HTTPS`);
  }
  if (parsed.username || parsed.password || parsed.href.length > 4_096) {
    throw new Error(`${label} contains unsupported credentials or is too long`);
  }
  return parsed.href;
}

function normalizeMetadata(
  metadata: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const encoded = JSON.stringify(metadata);
  if (encoded.length > 16_384) {
    throw new Error("artifact metadata is too large");
  }
  const parsed = JSON.parse(encoded) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new Error("artifact metadata must be an object");
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function parseMetadata(value: string): Readonly<Record<string, unknown>> {
  try {
    return normalizeMetadata(
      JSON.parse(value) as Readonly<Record<string, unknown>>,
    );
  } catch {
    return {};
  }
}

function ensureSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
