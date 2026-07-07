import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import {
  adminLawyerReferralUpdateInputSchema,
  listAdminLawyerReferralRequests,
  updateAdminLawyerReferralRequest,
} from "@/lib/admin-lawyer-referrals";

export async function GET(request: Request) {
  try {
    const response = await listAdminLawyerReferralRequests(bearerTokenFromRequest(request));
    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const input = adminLawyerReferralUpdateInputSchema.parse(await request.json());
    const response = await updateAdminLawyerReferralRequest({
      authToken: bearerTokenFromRequest(request),
      input,
    });
    return NextResponse.json(response);
  } catch (error) {
    return adminErrorResponse(error);
  }
}

function adminErrorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Erreur admin";
  const status = message.startsWith("Unauthorized")
    ? 401
    : message.startsWith("Forbidden")
      ? 403
      : 400;
  return NextResponse.json({ error: message }, { status });
}
