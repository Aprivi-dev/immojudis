import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { getAdminCatalogueQuality } from "@/lib/admin-catalogue-quality.server";
import { withAdminDeadline } from "@/lib/admin-route-deadline";
import { adminErrorResponse } from "@/lib/api-route-errors";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/**
 * Contrôles qualité du catalogue : dernier cliché de la sentinelle et alertes `catalogue.quality.*` ouvertes,
 * mis en forme pour le panneau de /admin/quality. Administrateur seulement, jamais mis en cache.
 */
async function handleGET(request: Request) {
  try {
    const view = await getAdminCatalogueQuality(bearerTokenFromRequest(request));
    return NextResponse.json(view, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return adminErrorResponse(error, {
      fallbackMessage: "Contrôles qualité du catalogue indisponibles",
      fallbackStatus: 500,
    });
  }
}

export const GET = withAdminDeadline(handleGET);
