import { NextResponse } from "next/server";
import { apiRouteError } from "@/lib/api-observability";
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

export async function GET(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const query = lawyerReferralListQuerySchema.parse({
      saleId: url.searchParams.get("saleId") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    return NextResponse.json(await listLawyerReferralRequests({ auth, query }));
  } catch (error) {
    return apiRouteError(error, request, "lawyer-referrals", {
      fallbackMessage: "Demandes indisponibles",
      extra: { requests: [] },
    });
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      bucketKey: "lawyer-referrals.create",
      ...RATE_LIMIT_POLICIES.formSubmit,
    });
    const input = lawyerReferralRequestInputSchema.parse(await request.json());
    const response = await createLawyerReferralRequest({ auth, input });
    return NextResponse.json(response, { status: response.reusedExisting ? 200 : 201 });
  } catch (error) {
    return apiRouteError(error, request, "lawyer-referrals", {
      fallbackMessage: "Demande impossible",
    });
  }
}
