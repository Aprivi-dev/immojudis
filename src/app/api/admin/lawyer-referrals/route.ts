import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import {
  adminLawyerReferralUpdateInputSchema,
  listAdminLawyerReferralRequests,
  updateAdminLawyerReferralRequest,
} from "@/lib/admin-lawyer-referrals";
import { adminPageQuerySchema } from "@/lib/admin-page-query";
import { adminRoute } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

export const GET = adminRoute(
  {
    scope: "admin.lawyer-referrals.read",
    fallbackMessage: "Mises en relation indisponibles",
  },
  async (request) => {
    const authToken = bearerTokenFromRequest(request);
    const page = adminPageQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams.entries()),
    );
    return listAdminLawyerReferralRequests(authToken, page);
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
