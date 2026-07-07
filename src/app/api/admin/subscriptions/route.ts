import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import {
  adminSubscriptionGrantInputSchema,
  grantAdminSubscription,
  listAdminSubscriptions,
} from "@/lib/admin-subscriptions";

export async function GET(request: Request) {
  try {
    const response = await listAdminSubscriptions(bearerTokenFromRequest(request));
    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return adminSubscriptionErrorResponse(error);
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
    return adminSubscriptionErrorResponse(error);
  }
}

function adminSubscriptionErrorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Erreur admin abonnement";
  const status = message.startsWith("Unauthorized")
    ? 401
    : message.startsWith("Forbidden")
      ? 403
      : 400;
  return NextResponse.json({ error: message }, { status });
}
