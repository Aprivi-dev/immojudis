import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import {
  adminInformationAgentReviewQuerySchema,
  adminInformationAgentReviewSchema,
  listAdminInformationAgentReview,
  reviewAdminInformationAgentFact,
} from "@/lib/admin-information-agent";
import { withAdminDeadline } from "@/lib/admin-route-deadline";
import { adminErrorResponse } from "@/lib/api-route-errors";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

async function handleGET(request: Request) {
  try {
    // `offset` / `limit` (50 par défaut, 100 au plus) bornent les deux listes ; le total est renvoyé.
    const input = adminInformationAgentReviewQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams.entries()),
    );
    const response = await listAdminInformationAgentReview(bearerTokenFromRequest(request), input);
    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

async function handlePATCH(request: Request) {
  try {
    const input = adminInformationAgentReviewSchema.parse(await request.json());
    const response = await reviewAdminInformationAgentFact({
      authToken: bearerTokenFromRequest(request),
      input,
    });
    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

export const GET = withAdminDeadline(handleGET);
export const PATCH = withAdminDeadline(handlePATCH);
