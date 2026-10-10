import { NextResponse } from "next/server";
import { z } from "zod";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import {
  adminInformationAgentReviewSchema,
  listAdminInformationAgentReview,
  reviewAdminInformationAgentFact,
} from "@/lib/admin-information-agent";
import { adminErrorResponse } from "@/lib/api-route-errors";
import { withAdminDeadline } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

async function handleGET(request: Request) {
  try {
    const searchParams = new URL(request.url).searchParams;
    const cursor = z.string().max(500).optional();
    const factCursor = cursor.parse(searchParams.get("factCursor") ?? undefined);
    const messageCursor = cursor.parse(searchParams.get("messageCursor") ?? undefined);
    const response = await listAdminInformationAgentReview(bearerTokenFromRequest(request), {
      factCursor,
      messageCursor,
    });
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
