import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { withAdminDeadline } from "@/lib/admin-route-deadline";
import { adminErrorResponse } from "@/lib/api-route-errors";
import { reconcileBillingReadOnly } from "@/lib/billing-reconciliation";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/**
 * Rapprochement Stripe / base, en lecture seule : liste les écarts, ne corrige rien.
 */
async function handleGET(request: Request) {
  try {
    const report = await reconcileBillingReadOnly(bearerTokenFromRequest(request));
    return NextResponse.json(report, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return adminErrorResponse(error, { fallbackMessage: "Rapprochement indisponible" });
  }
}

export const GET = withAdminDeadline(handleGET);
