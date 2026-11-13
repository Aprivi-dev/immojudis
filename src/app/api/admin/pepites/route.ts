import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import {
  adminPepitesSuspendSchema,
  getAdminPepites,
  suspendAdminPepites,
} from "@/lib/admin-pepites";
import { buildAdminPepitesView } from "@/lib/admin-pepites-view";
import { adminRoute } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/** Pépites : mode, compteurs, liste et contrôle d'indépendance. Administrateur seulement, jamais mis en cache. */
export const GET = adminRoute(
  { scope: "admin.pepites.read", fallbackMessage: "Pépites indisponibles" },
  async (request) => {
    const data = await getAdminPepites(bearerTokenFromRequest(request));
    // La mise en forme est faite ici : la page n'affiche que des sections prêtes (budget de JavaScript).
    return buildAdminPepitesView(data);
  },
);

/** Arrêt d'urgence : « on » vers « shadow » ou « off » seulement (jamais l'ouverture). */
export const POST = adminRoute(
  { scope: "admin.pepites.suspend", fallbackMessage: "Pépites non suspendues" },
  async (request) => {
    // Le jeton d'abord : sans session, la réponse est 401, que le corps soit valide ou non.
    const authToken = bearerTokenFromRequest(request);
    // Corps facultatif : sans corps, le mode par défaut du schéma (« shadow »).
    const raw = await request.text();
    const input = adminPepitesSuspendSchema.parse(raw.trim() ? JSON.parse(raw) : {});
    return suspendAdminPepites(authToken, input);
  },
);
