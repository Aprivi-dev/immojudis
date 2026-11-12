import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { apiRoute } from "@/lib/api-route";
import { readSaleFactClaims } from "@/lib/auction-fact-claims";
import { getFactReliabilitiesFromClaims } from "@/lib/fact-reliability";
import { buildLawyerQuestions } from "@/lib/lawyer-questions";
import type { LawyerQuestionsResponse } from "@/lib/lawyer-questions-text";
import { assertFeatureEntitlementVia, readSaleThroughDoor } from "@/lib/entitlements.server";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import { saleRow } from "@/lib/sale-rows";
import { SALE_LIST_COLUMNS } from "@/lib/sale-views";

const saleIdSchema = z.string().guid();

/**
 * « Mes questions pour l'avocat » : les points que la fiche laisse ouverts, formulés comme des
 * questions à poser à son avocat (voir `buildLawyerQuestions`). Calculé ici, pas dans le navigateur :
 * l'inventaire de la fiche reste côté serveur.
 *
 * Mêmes droits que la lecture des pièces : l'offre Analyse, ou une vente que le compte a débloquée
 * (« 3 déblocages par mois »), pour cette vente seulement. Les autres comptes reçoivent un refus. La vente
 * doit être visible de l'appelant (sa session, pas le rôle de service) et publiée.
 */
export const GET = apiRoute<{ id: string }>(
  {
    scope: "sales.id.lawyer-questions",
    fallbackMessage: "Questions pour l’avocat indisponibles.",
  },
  async (request, { params }) => {
    const saleId = saleIdSchema.parse(params.id);
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      bucketKey: "lawyer-questions",
      ...RATE_LIMIT_POLICIES.compute,
    });
    const { door } = await assertFeatureEntitlementVia(
      auth,
      "property.documentReading",
      "Les questions pour l’avocat sont réservées à l’offre Analyse.",
      { saleId },
    );
    // Analyse : la fiche complète ; un déblocage : les colonnes de la vue débloquée.
    const sale = await readSaleThroughDoor(
      auth,
      saleId,
      door,
      door === "plan" ? SALE_LIST_COLUMNS : "*",
    );

    const row = saleRow(sale);
    // Les preuves rattachées à la fiche (offre Analyse) précisent les faits clés ; sans elles, la fiche seule.
    const facts =
      door === "plan"
        ? getFactReliabilitiesFromClaims(row, (await readSaleFactClaims(saleId)).claims)
        : undefined;
    const body: LawyerQuestionsResponse = { questions: buildLawyerQuestions(row, facts) };
    return body;
  },
);
