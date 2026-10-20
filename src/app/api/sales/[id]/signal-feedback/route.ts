import { NextResponse } from "next/server";
import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { apiRouteError } from "@/lib/api-observability";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import { saleSignalFeedbackSchema } from "@/lib/sale-signal-feedback";
import { recordSaleSignalFeedback } from "@/lib/sale-signal-feedback.server";

const saleIdSchema = z.string().uuid();

const PRIVATE_HEADERS = { "cache-control": "private, no-store", vary: "authorization" };

/**
 * Retour « Utile » / « Pas pertinent » d'un compte sur un signal de cette vente (point 67) : la bande
 * d'écart au marché ou la liste des points à vérifier, avec un motif en liste fermée. Comptes connectés
 * seulement : sans jeton valide la route répond 401 sans rien enregistrer, il n'y a aucune mesure
 * anonyme. Le corps ne porte que le signal, la valeur et le motif (listes fermées, aucun texte libre) ;
 * la base garde un seul retour par compte, vente, signal et jour (le motif corrige celui du jour), refuse
 * une vente hors du catalogue public et plafonne les écritures d'un compte (voir la migration
 * 20261030110100). Conservé 90 jours.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const saleId = saleIdSchema.parse((await context.params).id);
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      bucketKey: "sale-signal-feedback",
      ...RATE_LIMIT_POLICIES.compute,
    });
    const input = saleSignalFeedbackSchema.parse(await request.json());
    const recorded = await recordSaleSignalFeedback(auth.userId, saleId, input);
    return NextResponse.json({ recorded }, { headers: PRIVATE_HEADERS });
  } catch (error) {
    return apiRouteError(error, request, "sale-signal-feedback", {
      fallbackMessage: "Retour indisponible.",
    });
  }
}
