import { revalidatePath, revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { z } from "zod";
import { cronRequestAuthorized } from "@/lib/cron-auth";
import { publicSaleCacheTag } from "@/lib/public-sale.server";
import { SALE_ID_PATTERN } from "@/lib/public-sale-summary";
import { resolveRequestId } from "@/lib/request-id";

const MAX_SALES_PER_CALL = 100;

const saleIdSchema = z.string().regex(SALE_ID_PATTERN, "Identifiant de vente invalide.");
const bodySchema = z.union([
  z.object({ saleId: saleIdSchema }).strict(),
  z.object({ saleIds: z.array(saleIdSchema).min(1).max(MAX_SALES_PER_CALL) }).strict(),
]);

/**
 * Cache invalidation called by the data pipeline once it has changed a sale (P6-06).
 *
 * `POST /api/pipeline/revalidate-sale` with `Authorization: Bearer $CRON_SECRET` (the secret
 * that already protects the Vercel Cron routes) and a JSON body `{ "saleId": "<uuid>" }`
 * or `{ "saleIds": ["<uuid>", ...] }` (at most 100). For every sale it expires the
 * `sale-<id>` data-cache tag and the cached page `/sales/<id>`: the next visitor triggers
 * a fresh read instead of waiting for the 5-minute revalidation.
 */
export async function POST(request: Request) {
  const requestId = resolveRequestId(request.headers.get("x-request-id"));
  const headers = { "cache-control": "no-store", "x-request-id": requestId };

  if (!cronRequestAuthorized(request)) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized", code: "AUTH_REQUIRED", requestId },
      { status: 401, headers },
    );
  }

  const payload = bodySchema.safeParse(await readJson(request));
  if (!payload.success) {
    return NextResponse.json(
      {
        ok: false,
        error: `Corps attendu : { "saleId": "<uuid>" } ou { "saleIds": [<uuid>, ...] } (${MAX_SALES_PER_CALL} au plus).`,
        code: "INVALID_REQUEST",
        requestId,
      },
      { status: 400, headers },
    );
  }

  const ids = [
    ...new Set(
      ("saleId" in payload.data ? [payload.data.saleId] : payload.data.saleIds).map((id) =>
        id.toLowerCase(),
      ),
    ),
  ];
  for (const id of ids) {
    // `expire: 0`: no stale copy is served, the next request reads the database.
    revalidateTag(publicSaleCacheTag(id), { expire: 0 });
    revalidatePath(`/sales/${id}`);
  }

  return NextResponse.json(
    { ok: true, revalidated: ids.map(publicSaleCacheTag), requestId },
    { headers },
  );
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
