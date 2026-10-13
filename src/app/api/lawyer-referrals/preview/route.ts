import { NextResponse } from "next/server";
import { apiRouteError } from "@/lib/api-observability";
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
export async function GET(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      bucketKey: "lawyer-referrals.preview",
      ...RATE_LIMIT_POLICIES.compute,
    });
    const url = new URL(request.url);
    const query = lawyerReferralPreviewQuerySchema.parse({
      saleId: url.searchParams.get("saleId") ?? undefined,
      lawyerId: url.searchParams.get("lawyerId") ?? undefined,
    });
    const response = await previewLawyerReferralRecipient({ auth, query });
    return NextResponse.json(response, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return apiRouteError(error, request, "lawyer-referrals.preview", {
      fallbackMessage: "Prévisualisation indisponible",
    });
  }
}
