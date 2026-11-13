import "server-only";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { PublicApiError } from "@/lib/api-errors";
import { apiRoute } from "@/lib/api-route";
import { DETAIL_VIEW, UNLOCKED_VIEW } from "@/lib/sale-views";
import {
  AI_REVIEW_CEILING_FIELD_KEYS,
  AI_REVIEW_FIELD_KEYS,
  type AiReviewProjectionReadModel,
} from "@/lib/ai-review-guard";
import { CANONICAL_COLUMNS, type CanonicalSaleRow } from "@/lib/ai-review-projection-rows";
import { readAiReviewProjections } from "@/lib/ai-review-projections.server";

const saleIdsSchema = z.array(z.string().guid()).min(1).max(500);

const ceilingFieldKeys = new Set<string>(AI_REVIEW_CEILING_FIELD_KEYS);

export type SaleAiReviewResponse = {
  projections: AiReviewProjectionReadModel[];
};

function response(payload: SaleAiReviewResponse) {
  return NextResponse.json(payload, { headers: { "referrer-policy": "no-referrer" } });
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

export const GET = apiRoute(
  {
    scope: "sales.ai-review",
    // Toute panne autre qu'une session absente est la même indisponibilité neutre.
    fallbackMessage: "La relecture IA de cette annonce est momentanément indisponible.",
    fallbackStatus: 503,
  },
  async (request) => {
    const ids = [...new Set(new URL(request.url).searchParams.getAll("id"))];
    const parsedIds = saleIdsSchema.safeParse(ids);
    if (!parsedIds.success) throw new PublicApiError("Identifiants de vente invalides.", 400);

    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const { data: visibleSales, error: visibilityError } = await auth.supabase
      .from(DETAIL_VIEW)
      .select(CANONICAL_COLUMNS)
      .in("id", parsedIds.data);
    if (visibilityError) throw visibilityError;

    const visibleSaleRows: CanonicalSaleRow[] = [...(visibleSales ?? [])];
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
      if (unlockedError) throw unlockedError;
      for (const sale of unlockedSales ?? []) {
        if (typeof sale.id !== "string") continue;
        visibleSaleRows.push(sale);
        visibleSaleIds.add(sale.id);
        unlockedSaleIds.add(sale.id);
      }
    }
    return response({
      projections: [
        ...(await readAiReviewProjections(visibleSaleRows)),
        ...unavailableSaleRows(parsedIds.data, visibleSaleIds),
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
  },
);
