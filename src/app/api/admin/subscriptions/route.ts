import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import {
  adminSubscriptionGrantInputSchema,
  grantAdminSubscription,
  listAdminSubscriptions,
} from "@/lib/admin-subscriptions";
import { adminRoute } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

export const GET = adminRoute(
  { scope: "admin.subscriptions.read", fallbackMessage: "Erreur admin abonnement" },
  async (request) => {
    const url = new URL(request.url);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 50);
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw new Error("Pagination abonnements invalide.");
    }
    return listAdminSubscriptions(bearerTokenFromRequest(request), { offset, limit });
  },
);

export const POST = adminRoute(
  { scope: "admin.subscriptions.grant", fallbackMessage: "Erreur admin abonnement" },
  async (request) => {
    const authToken = bearerTokenFromRequest(request);
    const input = adminSubscriptionGrantInputSchema.parse(await request.json());
    return grantAdminSubscription({ authToken, input });
  },
);
