import { NextResponse } from "next/server";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { apiRoute } from "@/lib/api-route";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import {
  createPrivacyRequest,
  listPrivacyRequests,
  privacyRequestInputSchema,
} from "@/lib/privacy-requests";

export const GET = apiRoute(
  { scope: "api.privacy.requests.list", fallbackMessage: "Demandes indisponibles." },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    return listPrivacyRequests(auth);
  },
);

export const POST = apiRoute(
  { scope: "api.privacy.requests.create", fallbackMessage: "Demande impossible." },
  async (request, { api }) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      bucketKey: "privacy-requests.create",
      ...RATE_LIMIT_POLICIES.formSubmit,
      context: api,
    });
    const input = privacyRequestInputSchema.parse(await request.json());
    const response = await createPrivacyRequest({ auth, input });
    return NextResponse.json(response, { status: 201 });
  },
);
