import { NextResponse } from "next/server";
import { PublicApiError } from "@/lib/api-errors";
import { apiRouteError } from "@/lib/api-observability";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import {
  adminAuctionFactClaimDecisionSchema,
  adminAuctionFactClaimReviewQuerySchema,
  listAdminAuctionFactClaims,
  reviewAdminAuctionFactClaim,
} from "@/lib/admin-auction-fact-claims-review";
import { withAdminDeadline } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

async function handleGET(request: Request): Promise<Response> {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = adminAuctionFactClaimReviewQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams.entries()),
    );
    const response = await listAdminAuctionFactClaims({ auth, input });
    return NextResponse.json(response, {
      headers: {
        "cache-control": "private, no-store",
        "referrer-policy": "no-referrer",
      },
    });
  } catch (error) {
    return reviewErrorResponse(error, request);
  }
}

async function handlePOST(request: Request): Promise<Response> {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = adminAuctionFactClaimDecisionSchema.parse(await request.json());
    const response = await reviewAdminAuctionFactClaim({ auth, input });
    return NextResponse.json(response, {
      headers: {
        "cache-control": "private, no-store",
        "referrer-policy": "no-referrer",
      },
    });
  } catch (error) {
    return reviewErrorResponse(error, request);
  }
}

function reviewErrorResponse(error: unknown, request: Request): Response {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  // Database conflicts (trigger 55000) and permission failures (42501) keep their HTTP
  // meaning but are reported with a French message; the driver detail stays in the logs.
  const translated =
    code === "42501"
      ? new PublicApiError("Action non autorisée.", 403)
      : code === "55000"
        ? new PublicApiError(
            "Ce fait a déjà été traité ou est en cours de traitement ailleurs.",
            409,
          )
        : error;
  return apiRouteError(translated, request, "admin.fact-claims.review", {
    fallbackMessage: "Revue du fait indisponible.",
  });
}

export const GET = withAdminDeadline(handleGET);
export const POST = withAdminDeadline(handlePOST);
