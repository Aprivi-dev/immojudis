import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import {
  adminSubscriptionGrantInputSchema,
  grantAdminSubscription,
  listAdminSubscriptions,
} from "@/lib/admin-subscriptions";
import { adminErrorResponse } from "@/lib/api-route-errors";

export async function GET(request: Request) {
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

export async function POST(request: Request) {
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
