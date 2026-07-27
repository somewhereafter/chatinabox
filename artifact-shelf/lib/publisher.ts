import { env } from "cloudflare:workers";
import type {
  ArtifactManifest,
  ArtifactMetadata,
  ArtifactRecord,
} from "../app/artifact-types";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_ARTIFACTS = 200;
const SHELF_ID = /^[A-Za-z0-9_-]{20,96}$/u;
const ARTIFACT_ID = /^[A-Za-z0-9_-]{1,128}$/u;

type RuntimeEnvironment = {
  PUBLISHER_TOKEN?: string;
};

export async function authorizePublisher(request: Request): Promise<boolean> {
  const configured = (env as RuntimeEnvironment).PUBLISHER_TOKEN?.trim();
  const supplied = bearerToken(request.headers.get("authorization"));
  if (!configured || configured.length < 32 || !supplied) return false;
  const [expectedHash, suppliedHash] = await Promise.all([
    digest(configured),
    digest(supplied),
  ]);
  let mismatch = 0;
  for (let index = 0; index < expectedHash.length; index += 1) {
    mismatch |= expectedHash[index] ^ suppliedHash[index];
  }
  return mismatch === 0;
}

export async function readManifest(
  request: Request,
  shelfId: string,
): Promise<ArtifactManifest> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_BODY_BYTES
  ) {
    throw new RequestError("manifest is too large", 413);
  }
  const bytes = await readBoundedBody(request, MAX_BODY_BYTES);
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new RequestError("request body must be valid JSON", 400);
  }
  return validateManifest(payload, shelfId);
}

export function validateShelfId(value: string): boolean {
  return SHELF_ID.test(value);
}

export function validateManifest(
  value: unknown,
  shelfId: string,
): ArtifactManifest {
  if (!isObject(value) || value.version !== 1) {
    throw new RequestError("unsupported manifest version", 400);
  }
  if (
    !isObject(value.shelf) ||
    value.shelf.id !== shelfId ||
    !SHELF_ID.test(shelfId) ||
    !validTimestamp(value.shelf.updatedAt)
  ) {
    throw new RequestError("invalid shelf identity", 400);
  }
  if (
    !Array.isArray(value.artifacts) ||
    value.artifacts.length > MAX_ARTIFACTS
  ) {
    throw new RequestError("invalid artifact collection", 400);
  }
  const ids = new Set<string>();
  const artifacts = value.artifacts.map((artifact) => {
    const normalized = validateArtifact(artifact);
    if (ids.has(normalized.id)) {
      throw new RequestError("artifact IDs must be unique", 400);
    }
    ids.add(normalized.id);
    return normalized;
  });
  return {
    version: 1,
    shelf: { id: shelfId, updatedAt: value.shelf.updatedAt },
    artifacts,
  };
}

export class RequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function validateArtifact(value: unknown): ArtifactRecord {
  if (
    !isObject(value) ||
    typeof value.id !== "string" ||
    !ARTIFACT_ID.test(value.id) ||
    typeof value.title !== "string" ||
    !validText(value.title, 240) ||
    typeof value.kind !== "string" ||
    !validText(value.kind, 80) ||
    !validTimestamp(value.createdAt) ||
    !isObject(value.metadata)
  ) {
    throw new RequestError("invalid artifact", 400);
  }
  const metadata = validateMetadata(value.metadata);
  const url = optionalUrl(value.url);
  const previewUrl = optionalUrl(value.previewUrl);
  const telegramMessageId = value.telegramMessageId;
  if (
    telegramMessageId !== undefined &&
    (!Number.isSafeInteger(telegramMessageId) || Number(telegramMessageId) < 1)
  ) {
    throw new RequestError("invalid Telegram message ID", 400);
  }
  return {
    id: value.id,
    title: value.title.trim(),
    kind: value.kind.trim(),
    ...(url ? { url } : {}),
    ...(previewUrl ? { previewUrl } : {}),
    ...(telegramMessageId !== undefined
      ? { telegramMessageId: Number(telegramMessageId) }
      : {}),
    metadata,
    createdAt: value.createdAt,
  };
}

function validateMetadata(value: Record<string, unknown>): ArtifactMetadata {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new RequestError("artifact metadata is invalid", 400);
  }
  if (encoded.length > 16_384) {
    throw new RequestError("artifact metadata is too large", 400);
  }
  return JSON.parse(encoded) as ArtifactMetadata;
}

function optionalUrl(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new RequestError("artifact URL is invalid", 400);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RequestError("artifact URL is invalid", 400);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.href.length > 4_096
  ) {
    throw new RequestError("artifact URL must be a safe HTTPS URL", 400);
  }
  return parsed.href;
}

function validText(value: string, max: number): boolean {
  const normalized = value.trim();
  return Boolean(normalized) &&
    normalized.length <= max &&
    !/[\u0000-\u001f]/u.test(normalized);
}

function validTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer ([^\s]{1,4096})$/u.exec(header);
  return match?.[1] ?? null;
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw new RequestError("manifest is too large", 413);
    }
    chunks.push(value);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
