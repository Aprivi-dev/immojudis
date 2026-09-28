import { NextResponse } from "next/server";
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

export async function GET(request: Request): Promise<Response> {
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
    return reviewErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
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
    return reviewErrorResponse(error);
  }
}

function reviewErrorResponse(error: unknown): Response {
  const message = errorMessage(error);
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  const status = message.startsWith("Unauthorized")
    ? 401
    : message.startsWith("Forbidden") || code === "42501"
      ? 403
      : code === "55000" || message.includes("canonical") || message.includes("concurrent")
        ? 409
        : 400;
  return NextResponse.json({ error: message }, { status });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return "Revue du fait indisponible.";
}
