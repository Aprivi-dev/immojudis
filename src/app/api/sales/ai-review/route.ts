import "server-only";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { errorDetailForLog, isUnauthorizedError } from "@/lib/api-errors";
import { DETAIL_VIEW, UNLOCKED_VIEW } from "@/lib/sale-views";
import {
  AI_REVIEW_CEILING_FIELD_KEYS,
  AI_REVIEW_FIELD_KEYS,
  type AiReviewProjectionReadModel,
} from "@/lib/ai-review-guard";
import {
  CANONICAL_COLUMNS,
  CASE_STATUS_COLUMNS,
  PROJECTION_COLUMNS,
  PUBLISHABLE_COLUMNS,
  canonicalMismatchKeys,
  missingProjectionRows,
  sampledSaleIds,
  sanitizeProjectionRows,
  type CanonicalSaleRow,
} from "@/lib/ai-review-projection-rows";

const saleIdsSchema = z.array(z.string().guid()).min(1).max(500);

const ceilingFieldKeys = new Set<string>(AI_REVIEW_CEILING_FIELD_KEYS);

const projectionReader = supabaseAdmin;

export type SaleAiReviewResponse = {
  projections: AiReviewProjectionReadModel[];
};

function response(payload: SaleAiReviewResponse | { error: string }, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      "cache-control": "private, no-store",
      vary: "authorization",
      "referrer-policy": "no-referrer",
    },
  });
}

/**
 * A row that must keep masking its value on the client (same rule as `getAiReviewFieldResult`):
 * not publishable, unresolved/unverified review, unverified citation or canonical drift.
 */
function isBlockingRow(projection: AiReviewProjectionReadModel): boolean {
  return (
    !projection.is_publishable ||
    projection.canonical_value_matches === false ||
    projection.review_state === "unresolved" ||
    projection.review_state === "unverified" ||
    projection.citation_status === "unverified"
  );
}

function unavailableSaleRows(
  requestedSaleIds: readonly string[],
  visibleSaleIds: ReadonlySet<string>,
): AiReviewProjectionReadModel[] {
  return requestedSaleIds
    .filter((id) => !visibleSaleIds.has(id))
    .flatMap((id) =>
      AI_REVIEW_FIELD_KEYS.map((fieldKey) => ({
        auction_sale_id: id,
        field_key: fieldKey,
        review_state: "unresolved" as const,
        citation_status: "not_required" as const,
        is_publishable: false,
        sale_unavailable: true,
        source_name: null,
        source_url: null,
      })),
    );
}

export async function GET(request: Request) {
  const ids = [...new Set(new URL(request.url).searchParams.getAll("id"))];
  const parsedIds = saleIdsSchema.safeParse(ids);
  if (!parsedIds.success) {
    return response({ error: "Identifiants de vente invalides." }, 400);
  }

  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const { data: visibleSales, error: visibilityError } = await auth.supabase
      .from(DETAIL_VIEW)
      .select(CANONICAL_COLUMNS)
      .in("id", parsedIds.data);
    if (visibilityError) throw visibilityError;

    const visibleSaleRows = (visibleSales ?? []) as CanonicalSaleRow[];
    const visibleSaleIds = new Set(
      visibleSaleRows.map((sale) => sale.id).filter((id): id is string => typeof id === "string"),
    );
    // A Découverte account does not read the full catalogue view; the sales it unlocked
    // (« 3 déblocages par mois ») are visible through their own view. The review stays applied to
    // the figures of the bid ceiling (AI_REVIEW_CEILING_FIELD_KEYS). For the other fields (city,
    // address, date, parking, energy) the unlocked view exposes the value itself, so the blocking
    // rows stay: the client must keep masking a value the review blocked. Only the publishable
    // rows are dropped there. Neither the citation links nor the source names of an unlocked sale
    // come back.
    const unlockedSaleIds = new Set<string>();
    const hiddenIds = parsedIds.data.filter((id) => !visibleSaleIds.has(id));
    if (hiddenIds.length > 0) {
      const { data: unlockedSales, error: unlockedError } = await auth.supabase
        .from(UNLOCKED_VIEW)
        .select(CANONICAL_COLUMNS)
        .in("id", hiddenIds);
      // A database without the unlock view yet (staggered deployment) has no unlocked sale.
      if (unlockedError && unlockedError.code !== "PGRST205" && unlockedError.code !== "42P01") {
        throw unlockedError;
      }
      for (const sale of (unlockedSales ?? []) as unknown as CanonicalSaleRow[]) {
        if (typeof sale.id !== "string") continue;
        visibleSaleRows.push(sale);
        visibleSaleIds.add(sale.id);
        unlockedSaleIds.add(sale.id);
      }
    }
    const unavailableRows = unavailableSaleRows(parsedIds.data, visibleSaleIds);
    if (visibleSaleIds.size === 0) return response({ projections: unavailableRows });

    const { data: projections, error: projectionError } = await projectionReader
      .from("v_auction_ai_review_projection_read_model")
      .select(PROJECTION_COLUMNS)
      .in("auction_sale_id", [...visibleSaleIds]);
    if (projectionError) throw projectionError;

    const { data: caseStatuses, error: caseStatusError } = await projectionReader
      .from("auction_ai_review_case_status")
      .select(CASE_STATUS_COLUMNS)
      .in("auction_sale_id", [...visibleSaleIds]);
    if (caseStatusError) throw caseStatusError;

    const safeProjections = sanitizeProjectionRows(projections, visibleSaleIds);
    const missingRows = missingProjectionRows(
      sampledSaleIds(caseStatuses, visibleSaleIds),
      safeProjections,
    );
    const publishableKeys = safeProjections
      .filter((projection) => projection.is_publishable && projection.auction_sale_id)
      .map((projection) => `${projection.auction_sale_id}:${projection.field_key}`);
    let canonicalMismatches = new Set<string>();
    if (publishableKeys.length) {
      const { data: publishableRows, error: publishableError } = await projectionReader
        .from("v_auction_ai_review_publishable")
        .select(PUBLISHABLE_COLUMNS)
        .in("auction_sale_id", [...visibleSaleIds]);
      if (publishableError) throw publishableError;
      canonicalMismatches = canonicalMismatchKeys(
        safeProjections,
        publishableRows,
        visibleSaleRows,
      );
    }

    return response({
      projections: [
        ...sanitizeProjectionRows(projections, visibleSaleIds, canonicalMismatches),
        ...missingRows,
        ...unavailableRows,
      ]
        .filter(
          (projection) =>
            !projection.auction_sale_id ||
            !unlockedSaleIds.has(projection.auction_sale_id) ||
            ceilingFieldKeys.has(projection.field_key) ||
            isBlockingRow(projection),
        )
        .map((projection) =>
          projection.auction_sale_id && unlockedSaleIds.has(projection.auction_sale_id)
            ? { ...projection, source_name: null, source_url: null }
            : projection,
        ),
    });
  } catch (error) {
    // Only the authentication failure is distinguishable; every other failure is the
    // same neutral outage message and the detail goes to the server logs.
    const unauthorized = isUnauthorizedError(error);
    console.error(
      JSON.stringify({
        scope: "sales.ai-review",
        status: unauthorized ? 401 : 503,
        error: errorDetailForLog(error),
      }),
    );
    return response(
      {
        error: unauthorized
          ? "Authentification requise."
          : "La relecture IA de cette annonce est momentanément indisponible.",
      },
      unauthorized ? 401 : 503,
    );
  }
}
