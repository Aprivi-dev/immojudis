import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import {
  adminSignupListQuerySchema,
  adminTrialExtensionInputSchema,
  extendAdminSignupTrials,
  listAdminSignups,
} from "@/lib/admin-signups";
import { adminErrorResponse } from "@/lib/api-route-errors";
import { withAdminDeadline } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

async function handleGET(request: Request) {
  try {
    const url = new URL(request.url);
    const query = adminSignupListQuerySchema.parse({
      offset: url.searchParams.get("offset") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
      q: url.searchParams.get("q") ?? undefined,
      access: url.searchParams.get("access") ?? undefined,
      activity: url.searchParams.get("activity") ?? undefined,
    });
    const response = await listAdminSignups(bearerTokenFromRequest(request), query);
    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return adminErrorResponse(error, { fallbackMessage: "Erreur admin inscriptions" });
  }
}

async function handlePOST(request: Request) {
  try {
    const input = adminTrialExtensionInputSchema.parse(await request.json());
    const response = await extendAdminSignupTrials({
      authToken: bearerTokenFromRequest(request),
      input,
    });
    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return adminErrorResponse(error, { fallbackMessage: "Erreur admin prolongation d'essai" });
  }
}

export const GET = withAdminDeadline(handleGET);
export const POST = withAdminDeadline(handlePOST);
