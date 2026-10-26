import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { withAdminDeadline } from "@/lib/admin-route-deadline";
import {
  adminPepitesSuspendSchema,
  getAdminPepites,
  suspendAdminPepites,
} from "@/lib/admin-pepites";
import { buildAdminPepitesView } from "@/lib/admin-pepites-view";
import { adminErrorResponse } from "@/lib/api-route-errors";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/** Pépites : mode, compteurs, liste et contrôle d'indépendance. Administrateur seulement, jamais mis en cache. */
async function handleGET(request: Request) {
  try {
    const data = await getAdminPepites(bearerTokenFromRequest(request));
    // La mise en forme est faite ici : la page n'affiche que des sections prêtes (budget de JavaScript).
    return NextResponse.json(buildAdminPepitesView(data), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return adminErrorResponse(error, {
      fallbackMessage: "Pépites indisponibles",
      fallbackStatus: 500,
    });
  }
}

/** Arrêt d'urgence : « on » vers « shadow » ou « off » seulement (jamais l'ouverture). */
async function handlePOST(request: Request) {
  try {
    const input = adminPepitesSuspendSchema.parse(await request.json().catch(() => ({})));
    const result = await suspendAdminPepites(bearerTokenFromRequest(request), input);
    return NextResponse.json(result, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return adminErrorResponse(error, {
      fallbackMessage: "Pépites non suspendues",
      fallbackStatus: 500,
    });
  }
}

export const GET = withAdminDeadline(handleGET);
export const POST = withAdminDeadline(handlePOST);
