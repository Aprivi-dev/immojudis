import { NextResponse } from "next/server";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
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
    const message = error instanceof Error ? error.message : "Demandes indisponibles";
    const status = message.startsWith("Unauthorized") ? 401 : 400;
    return NextResponse.json({ requests: [], error: message }, { status });
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = lawyerReferralRequestInputSchema.parse(await request.json());
    const response = await createLawyerReferralRequest({ auth, input });
    return NextResponse.json(response, { status: response.reusedExisting ? 200 : 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Demande impossible";
    const status = message.startsWith("Unauthorized")
      ? 401
      : message.includes("réservée")
        ? 403
        : 400;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
