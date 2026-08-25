import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import {
  adminInformationAgentReviewSchema,
  listAdminInformationAgentReview,
  reviewAdminInformationAgentFact,
} from "@/lib/admin-information-agent";

export async function GET(request: Request) {
  try {
    const response = await listAdminInformationAgentReview(bearerTokenFromRequest(request));
    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return adminError(error);
  }
}

export async function PATCH(request: Request) {
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
    return adminError(error);
  }
}

function adminError(error: unknown) {
  const message = error instanceof Error ? error.message : "Erreur admin";
  const status = message.startsWith("Unauthorized")
    ? 401
    : message.startsWith("Forbidden")
      ? 403
      : 400;
  return NextResponse.json({ error: message }, { status });
}
