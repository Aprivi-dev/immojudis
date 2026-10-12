import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import {
  adminPublicationQuerySchema,
  adminPublicationReviewInputSchema,
  listAdminPublicationRequests,
  reviewAdminPublicationRequest,
} from "@/lib/admin-publication-requests";
import { adminErrorResponse } from "@/lib/api-route-errors";
import { withAdminDeadline } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

async function handleGET(request: Request) {
  try {
    const url = new URL(request.url);
    const input = adminPublicationQuerySchema.parse({
      status: url.searchParams.get("status") ?? undefined,
      search: url.searchParams.get("search") ?? undefined,
      offset: url.searchParams.get("offset") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    const response = await listAdminPublicationRequests({
      authToken: bearerTokenFromRequest(request),
      input,
    });
    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return adminErrorResponse(error, {
      fallbackMessage: "Demandes de publication indisponibles.",
    });
  }
}

async function handlePATCH(request: Request) {
  try {
    const input = adminPublicationReviewInputSchema.parse(await request.json());
    const response = await reviewAdminPublicationRequest({
      authToken: bearerTokenFromRequest(request),
      input,
    });
    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return adminErrorResponse(error, {
      fallbackMessage: "Mise à jour de la publication impossible.",
    });
  }
}

export const GET = withAdminDeadline(handleGET);
export const PATCH = withAdminDeadline(handlePATCH);
