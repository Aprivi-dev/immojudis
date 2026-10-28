import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { withAdminDeadline } from "@/lib/admin-route-deadline";
import { getAdminSaleFeedbackBySale } from "@/lib/admin-sale-signal-feedback";
import { adminErrorResponse } from "@/lib/api-route-errors";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/**
 * Retours « Pas pertinent » par vente, signal et motif (90 jours) : de quoi corriger la fiche en cause.
 * Administrateur seulement, jamais mis en cache. Aucun compte dans la réponse.
 */
async function handleGET(request: Request) {
  try {
    const feedback = await getAdminSaleFeedbackBySale(bearerTokenFromRequest(request));
    return NextResponse.json(feedback, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return adminErrorResponse(error, {
      fallbackMessage: "Retours par vente indisponibles",
      fallbackStatus: 500,
    });
  }
}

export const GET = withAdminDeadline(handleGET);
