import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import {
  adminLawyerReferralUpdateInputSchema,
  listAdminLawyerReferralRequests,
  updateAdminLawyerReferralRequest,
} from "@/lib/admin-lawyer-referrals";
import { adminRoute } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

export const GET = adminRoute(
  {
    scope: "admin.lawyer-referrals.read",
    fallbackMessage: "Mises en relation indisponibles",
  },
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
      throw new Error("Pagination des mises en relation invalide.");
    }
    return listAdminLawyerReferralRequests(bearerTokenFromRequest(request), { offset, limit });
  },
);

export const PATCH = adminRoute(
  {
    scope: "admin.lawyer-referrals.write",
    fallbackMessage: "Mise en relation non modifiée",
  },
  async (request) => {
    const authToken = bearerTokenFromRequest(request);
    const input = adminLawyerReferralUpdateInputSchema.parse(await request.json());
    return updateAdminLawyerReferralRequest({ authToken, input });
  },
);
