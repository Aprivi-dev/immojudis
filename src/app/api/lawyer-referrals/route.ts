import { NextResponse } from "next/server";
import { apiRoute } from "@/lib/api-route";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import {
  createLawyerReferralRequest,
  listLawyerReferralRequests,
  lawyerReferralListQuerySchema,
  lawyerReferralRequestInputSchema,
} from "@/lib/lawyer-referrals";

export const GET = apiRoute(
  {
    scope: "api.lawyer-referrals.list",
    fallbackMessage: "Demandes indisponibles",
    emptyBody: { requests: [] },
  },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const query = lawyerReferralListQuerySchema.parse({
      saleId: url.searchParams.get("saleId") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    return listLawyerReferralRequests({ auth, query });
  },
);

export const POST = apiRoute(
  { scope: "api.lawyer-referrals.create", fallbackMessage: "Demande impossible" },
  async (request, { api }) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      bucketKey: "lawyer-referrals.create",
      ...RATE_LIMIT_POLICIES.formSubmit,
      context: api,
    });
    const input = lawyerReferralRequestInputSchema.parse(await request.json());
    const response = await createLawyerReferralRequest({ auth, input, request });
    return NextResponse.json(response, { status: response.reusedExisting ? 200 : 201 });
  },
);
