import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { getValuationAdminOverview } from "@/lib/valuation-admin";
import { adminErrorResponse } from "@/lib/api-route-errors";
import { withAdminDeadline } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

export const runtime = "nodejs";

async function handleGET(request: Request) {
  try {
    const overview = await getValuationAdminOverview(bearerTokenFromRequest(request));
    return NextResponse.json(overview, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return adminErrorResponse(error, {
      fallbackMessage: "Modèles de valorisation indisponibles",
      fallbackStatus: 500,
    });
  }
}

export const GET = withAdminDeadline(handleGET);
