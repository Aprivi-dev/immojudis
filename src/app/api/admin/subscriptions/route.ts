import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import {
  adminSubscriptionGrantInputSchema,
  grantAdminSubscription,
  listAdminSubscriptions,
} from "@/lib/admin-subscriptions";
import { adminErrorResponse } from "@/lib/api-route-errors";
import { withAdminDeadline } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

async function handleGET(request: Request) {
  try {
    const url = new URL(request.url);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 50);
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw new Error("Pagination abonnements invalide.");
    }
    const response = await listAdminSubscriptions(bearerTokenFromRequest(request), {
      offset,
      limit,
    });
    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return adminErrorResponse(error, { fallbackMessage: "Erreur admin abonnement" });
  }
}

async function handlePOST(request: Request) {
  try {
    const input = adminSubscriptionGrantInputSchema.parse(await request.json());
    const response = await grantAdminSubscription({
      authToken: bearerTokenFromRequest(request),
      input,
    });
    return NextResponse.json(response);
  } catch (error) {
    return adminErrorResponse(error, { fallbackMessage: "Erreur admin abonnement" });
  }
}

export const GET = withAdminDeadline(handleGET);
export const POST = withAdminDeadline(handlePOST);
