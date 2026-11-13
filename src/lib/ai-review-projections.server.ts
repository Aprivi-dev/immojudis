import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { AiReviewProjectionReadModel } from "@/lib/ai-review-guard";
import {
  CASE_STATUS_COLUMNS,
  PROJECTION_COLUMNS,
  PUBLISHABLE_COLUMNS,
  canonicalMismatchKeys,
  missingProjectionRows,
  sampledSaleIds,
  sanitizeProjectionRows,
  type CanonicalSaleRow,
} from "@/lib/ai-review-projection-rows";

/**
 * La relecture IA de ces ventes, telle que la fiche la sert : lignes de projection assainies, valeur relue
 * bloquée quand elle ne correspond plus à la valeur canonique de la vente, et lignes « projection manquante »
 * des ventes de l'échantillon. Lu avec le rôle de service : l'appelant a déjà vérifié que ces ventes lui sont
 * visibles (route `/api/sales/ai-review`) ou lit toutes les ventes en ligne (calcul des pépites).
 */
export async function readAiReviewProjections(
  sales: readonly CanonicalSaleRow[],
): Promise<AiReviewProjectionReadModel[]> {
  const saleIds = new Set(sales.flatMap((sale) => (typeof sale.id === "string" ? [sale.id] : [])));
  if (saleIds.size === 0) return [];
  const ids = [...saleIds];

  const { data: projections, error: projectionError } = await supabaseAdmin
    .from("v_auction_ai_review_projection_read_model")
    .select(PROJECTION_COLUMNS)
    .in("auction_sale_id", ids);
  if (projectionError) throw projectionError;
  const { data: caseStatuses, error: caseStatusError } = await supabaseAdmin
    .from("auction_ai_review_case_status")
    .select(CASE_STATUS_COLUMNS)
    .in("auction_sale_id", ids);
  if (caseStatusError) throw caseStatusError;

  const safeProjections = sanitizeProjectionRows(projections, saleIds);
  const missingRows = missingProjectionRows(sampledSaleIds(caseStatuses, saleIds), safeProjections);
  let canonicalMismatches = new Set<string>();
  if (
    safeProjections.some((projection) => projection.is_publishable && projection.auction_sale_id)
  ) {
    const { data: publishableRows, error: publishableError } = await supabaseAdmin
      .from("v_auction_ai_review_publishable")
      .select(PUBLISHABLE_COLUMNS)
      .in("auction_sale_id", ids);
    if (publishableError) throw publishableError;
    canonicalMismatches = canonicalMismatchKeys(safeProjections, publishableRows, sales);
  }
  return [...sanitizeProjectionRows(projections, saleIds, canonicalMismatches), ...missingRows];
}
