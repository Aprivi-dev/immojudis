import { NextResponse } from "next/server";
import { apiRouteError } from "@/lib/api-observability";
import { translateFactClaimDatabaseError } from "@/lib/fact-claim-database-errors";
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
  // Database conflicts (trigger 55000) and permission failures (42501) keep their HTTP
  // meaning but are reported with a French message; the driver detail stays in the logs.
  // Since the fact registry (lot R2b) the review locks the sale first, for 3 seconds at most: a
  // collection batch holding the sale gives 55P03 (sale_busy), a merge in progress gives 40001
  // (retry). Both mean "try again", not "already handled".
  return apiRouteError(
    translateFactClaimDatabaseError(error, { reviewStateConflicts: true }),
    request,
    "admin.fact-claims.review",
    {
      fallbackMessage: "Revue du fait indisponible.",
    },
  );
}

export const GET = withAdminDeadline(handleGET);
export const POST = withAdminDeadline(handlePOST);
