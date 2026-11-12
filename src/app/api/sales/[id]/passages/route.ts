import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { apiRoute } from "@/lib/api-route";
import { readSaleThroughDoor, saleFeatureDoor } from "@/lib/entitlements.server";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import type { SalePassagesResponse } from "@/lib/sale-passages";
import { getSalePassages } from "@/lib/sale-passages.server";
import { recordFeatureUsageEvent } from "@/lib/usage";

const saleIdSchema = z.string().guid();

/**
 * « Historique de la vente ». Analyse, or a sale the account unlocked: the full
 * timeline and the earlier passages of the property. Other signed-in accounts:
 * the counts only, as an invitation to the offer. The sale must be visible to the caller first.
 */
export const GET = apiRoute<{ id: string }>(
  { scope: "sale-passages", fallbackMessage: "Historique de la vente indisponible." },
  async (request, { params }) => {
    const saleId = saleIdSchema.parse(params.id);
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      bucketKey: "sale-passages",
      ...RATE_LIMIT_POLICIES.compute,
    });
    // Analyse, or a Découverte account that unlocked this very sale (« 3 déblocages par mois »).
    const door = await saleFeatureDoor(auth, "property.saleHistory", saleId);
    const full = door !== null;
    const sale = await readSaleThroughDoor<{ starting_price_eur: number | null }>(
      auth,
      saleId,
      door,
      "id, starting_price_eur",
    );

    const passages = await getSalePassages(saleId, sale.starting_price_eur);
    let body: SalePassagesResponse = passages;
    if (full) {
      recordFeatureUsageEvent({
        auth,
        eventKey: "sale_history.viewed",
        subjectType: "auction_sale",
        subjectId: saleId,
        metadata: { view: "passages", previous_passages: passages.summary.previousPassageCount },
      });
    } else {
      body = { access: "teaser", summary: passages.summary };
    }
    return body;
  },
);
