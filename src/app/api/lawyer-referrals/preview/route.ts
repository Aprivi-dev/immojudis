import { apiRoute } from "@/lib/api-route";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import {
  lawyerReferralPreviewQuerySchema,
  previewLawyerReferralRecipient,
} from "@/lib/lawyer-referrals";

/**
 * Who would receive a referral request for this sale, shown before the user consents. Read-only:
 * nothing is created, recorded or sent.
 */
export const GET = apiRoute(
  { scope: "api.lawyer-referrals.preview", fallbackMessage: "Prévisualisation indisponible" },
  async (request, { api }) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      bucketKey: "lawyer-referrals.preview",
      ...RATE_LIMIT_POLICIES.compute,
      context: api,
    });
    const url = new URL(request.url);
    const query = lawyerReferralPreviewQuerySchema.parse({
      saleId: url.searchParams.get("saleId") ?? undefined,
      lawyerId: url.searchParams.get("lawyerId") ?? undefined,
    });
    return previewLawyerReferralRecipient({ auth, query });
  },
);
