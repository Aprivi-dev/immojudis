import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { getAdminOfferOpeningInterviewees } from "@/lib/admin-offer-opening-survey";
import { withAdminDeadline } from "@/lib/admin-route-deadline";
import { adminErrorResponse } from "@/lib/api-route-errors";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/**
 * Liste des personnes qui ont accepté un entretien (questionnaire de la liste d'attente) : lecture
 * seule, administrateur seulement, jamais mise en cache. Elle porte des adresses email : elle n'est
 * pas dans la réponse de « Pilotage » et ne se charge qu'à la demande de l'administrateur.
 */
async function handleGET(request: Request) {
  try {
    const list = await getAdminOfferOpeningInterviewees(bearerTokenFromRequest(request));
    return NextResponse.json(list, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return adminErrorResponse(error, {
      fallbackMessage: "Liste des entretiens indisponible",
      fallbackStatus: 500,
    });
  }
}

export const GET = withAdminDeadline(handleGET);
