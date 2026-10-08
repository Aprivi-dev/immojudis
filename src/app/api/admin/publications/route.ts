import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import {
  adminPublicationQuerySchema,
  adminPublicationReviewInputSchema,
  listAdminPublicationRequests,
  reviewAdminPublicationRequest,
} from "@/lib/admin-publication-requests";
import { adminErrorResponse } from "@/lib/api-route-errors";

export async function GET(request: Request) {
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

export async function PATCH(request: Request) {
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
