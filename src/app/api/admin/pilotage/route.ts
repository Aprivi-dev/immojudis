import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { withAdminDeadline } from "@/lib/admin-route-deadline";
import { getAdminPilotage } from "@/lib/admin-pilotage";
import { adminErrorResponse } from "@/lib/api-route-errors";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/** Agrégats de la page « Pilotage » : administrateur seulement, jamais mis en cache. */
async function handleGET(request: Request) {
  try {
    const pilotage = await getAdminPilotage(bearerTokenFromRequest(request));
    return NextResponse.json(pilotage, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return adminErrorResponse(error, {
      fallbackMessage: "Pilotage indisponible",
      fallbackStatus: 500,
    });
  }
}

export const GET = withAdminDeadline(handleGET);
