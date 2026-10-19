import { NextResponse } from "next/server";
import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { recordAccountProductEvent } from "@/lib/account-product-events.server";
import { apiRouteError } from "@/lib/api-observability";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";

const saleIdSchema = z.string().uuid();

/**
 * Mesure par compte de « Ajouter à mon agenda » (point 65). Le fichier `.ics` lui-même
 * (`../route.ts`) est public, mis en cache par le CDN et ne connaît aucun compte : le navigateur
 * d'une personne connectée signale ici, après un téléchargement réussi, qu'il a eu lieu. Un visiteur
 * sans compte n'appelle pas cette route, et sans jeton valide elle répond 401 sans rien enregistrer.
 * L'événement ne porte que le compte, la vente et l'heure ; il est conservé 90 jours.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const saleId = saleIdSchema.parse((await context.params).id);
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      bucketKey: "sale-calendar-exported",
      ...RATE_LIMIT_POLICIES.compute,
    });
    const recorded = await recordAccountProductEvent(auth.userId, {
      type: "calendar_exported",
      saleId,
    });
    return NextResponse.json({ recorded }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return apiRouteError(error, request, "sale-calendar-exported", {
      fallbackMessage: "Mesure indisponible.",
    });
  }
}
