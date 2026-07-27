import { getRawDb } from "../../../../db";
import { authorizePublisher } from "../../../../lib/publisher";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!(await authorizePublisher(request))) {
    return Response.json(
      { ok: false, error: "unauthorized" },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }
  try {
    await getRawDb().prepare("SELECT 1 AS ok").first();
    return Response.json(
      { ok: true },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json(
      { ok: false, error: "storage unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
