import { eq } from "drizzle-orm";
import { artifactShelves } from "../../../../../db/schema";
import { getDb } from "../../../../../db";
import {
  authorizePublisher,
  readManifest,
  RequestError,
  validateManifest,
  validateShelfId,
} from "../../../../../lib/publisher";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ shelfId: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const { shelfId } = await context.params;
  if (!validateShelfId(shelfId)) {
    return errorResponse("shelf not found", 404);
  }
  try {
    const row = await getDb().query.artifactShelves.findFirst({
      where: eq(artifactShelves.id, shelfId),
    });
    if (!row) return errorResponse("shelf not found", 404);
    const manifest = validateManifest(JSON.parse(row.manifestJson), shelfId);
    return Response.json(
      { ok: true, manifest },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch {
    return errorResponse("shelf unavailable", 503);
  }
}

export async function PUT(request: Request, context: RouteContext) {
  if (!(await authorizePublisher(request))) {
    return errorResponse("unauthorized", 401);
  }
  const { shelfId } = await context.params;
  if (!validateShelfId(shelfId)) {
    return errorResponse("invalid shelf identity", 400);
  }
  try {
    const manifest = await readManifest(request, shelfId);
    await getDb()
      .insert(artifactShelves)
      .values({
        id: shelfId,
        manifestJson: JSON.stringify(manifest),
        updatedAt: manifest.shelf.updatedAt,
      })
      .onConflictDoUpdate({
        target: artifactShelves.id,
        set: {
          manifestJson: JSON.stringify(manifest),
          updatedAt: manifest.shelf.updatedAt,
        },
      });

    const requestUrl = new URL(request.url);
    const shelfUrl =
      `${requestUrl.origin}/?shelf=${encodeURIComponent(shelfId)}`;
    return Response.json(
      {
        ok: true,
        shelfUrl,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof RequestError) {
      return errorResponse(error.message, error.status);
    }
    return errorResponse("artifact storage failed", 503);
  }
}

function errorResponse(message: string, status: number) {
  return Response.json(
    { ok: false, error: message },
    { status, headers: { "cache-control": "no-store" } },
  );
}
