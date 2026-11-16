import { z } from "zod";
import { adminRoute } from "@/lib/admin-route-deadline";
import { getErasureGuardForRequest } from "@/lib/privacy-requests";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

const querySchema = z.object({ requestId: z.string().guid() });

/**
 * Garde avant effacement, affichée par le panneau : abonnement actif, achat à l'unité encore
 * rétractable, crédit non utilisé. L'exécution les revérifie et exige alors une confirmation.
 */
export const GET = adminRoute(
  {
    scope: "api.admin.privacy_requests.erasure_guard",
    fallbackMessage: "Vérification impossible.",
    guard: "admin",
  },
  async (request, { auth }) => {
    const { requestId } = querySchema.parse({
      requestId: new URL(request.url).searchParams.get("requestId"),
    });
    return getErasureGuardForRequest({ auth, requestId });
  },
);
