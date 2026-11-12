import { NextResponse } from "next/server";
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
import { adminRoute } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

const NO_REFERRER = { "referrer-policy": "no-referrer" };
const OPTIONS = {
  scope: "admin.fact-claims.review",
  fallbackMessage: "Revue du fait indisponible.",
};

export const GET = adminRoute(OPTIONS, async (request) => {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = adminAuctionFactClaimReviewQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams.entries()),
    );
    const response = await listAdminAuctionFactClaims({ auth, input });
    return NextResponse.json(response, { headers: NO_REFERRER });
  } catch (error) {
    throw reviewError(error);
  }
});

export const POST = adminRoute(OPTIONS, async (request) => {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = adminAuctionFactClaimDecisionSchema.parse(await request.json());
    const response = await reviewAdminAuctionFactClaim({ auth, input });
    return NextResponse.json(response, { headers: NO_REFERRER });
  } catch (error) {
    throw reviewError(error);
  }
});

function reviewError(error: unknown): unknown {
  // Database conflicts (trigger 55000) and permission failures (42501) keep their HTTP
  // meaning but are reported with a French message; the driver detail stays in the logs.
  // Since the fact registry (lot R2b) the review locks the sale first, for 3 seconds at most: a
  // collection batch holding the sale gives 55P03 (sale_busy), a merge in progress gives 40001
  // (retry). Both mean "try again", not "already handled".
  return translateFactClaimDatabaseError(error, { reviewStateConflicts: true });
}
