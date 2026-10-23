import { NextResponse } from "next/server";
import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { PublicApiError } from "@/lib/api-errors";
import { apiRouteError } from "@/lib/api-observability";
import { readSaleFactClaims } from "@/lib/auction-fact-claims";
import { getFactReliabilitiesFromClaims } from "@/lib/fact-reliability";
import { buildLawyerQuestions } from "@/lib/lawyer-questions";
import type { LawyerQuestionsResponse } from "@/lib/lawyer-questions-text";
import { saleFeatureDoor } from "@/lib/property-reports";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import { assertSalePublicationVisible } from "@/lib/sale-publication-guard";
import { saleRow } from "@/lib/sale-rows";
import { DETAIL_VIEW, SALE_LIST_COLUMNS, UNLOCKED_VIEW } from "@/lib/sale-views";

const saleIdSchema = z.string().uuid();

/**
 * « Mes questions pour l'avocat » : les points que la fiche laisse ouverts, formulés comme des
 * questions à poser à son avocat (voir `buildLawyerQuestions`). Calculé ici, pas dans le navigateur :
 * l'inventaire de la fiche reste côté serveur.
 *
 * Mêmes droits que la lecture des pièces : l'offre Analyse, ou une vente que le compte a débloquée
 * (« 3 déblocages par mois »), pour cette vente seulement. Les autres comptes reçoivent un refus. La vente
 * doit être visible de l'appelant (sa session, pas le rôle de service) et publiée.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const saleId = saleIdSchema.parse((await context.params).id);
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      bucketKey: "lawyer-questions",
      ...RATE_LIMIT_POLICIES.compute,
    });
    const door = await saleFeatureDoor(auth, "property.documentReading", saleId);
    if (!door) {
      throw new PublicApiError(
        "Les questions pour l’avocat sont réservées à l’offre Analyse.",
        403,
      );
    }
    // Analyse : la fiche complète ; un déblocage : les colonnes de la vue débloquée.
    const { data: sale, error } =
      door === "plan"
        ? await auth.supabase
            .from(DETAIL_VIEW)
            .select(SALE_LIST_COLUMNS)
            .eq("id", saleId)
            .maybeSingle()
        : await auth.supabase.from(UNLOCKED_VIEW).select("*").eq("id", saleId).maybeSingle();
    if (error) throw error;
    if (!sale) throw new PublicApiError("Vente introuvable.", 404);
    // Un JWT administrateur contourne la sécurité par ligne : même contrôle de publication que la fiche.
    await assertSalePublicationVisible(saleId);

    const row = saleRow(sale);
    // Les preuves rattachées à la fiche (offre Analyse) précisent les faits clés ; sans elles, la fiche seule.
    const facts =
      door === "plan"
        ? getFactReliabilitiesFromClaims(row, (await readSaleFactClaims(saleId)).claims)
        : undefined;
    const body: LawyerQuestionsResponse = { questions: buildLawyerQuestions(row, facts) };
    return NextResponse.json(body, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return apiRouteError(error, request, "sales.id.lawyer-questions", {
      fallbackMessage: "Questions pour l’avocat indisponibles.",
    });
  }
}
