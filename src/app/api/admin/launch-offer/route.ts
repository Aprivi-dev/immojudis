import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { withAdminDeadline } from "@/lib/admin-route-deadline";
import {
  adminLaunchOfferActionSchema,
  getAdminLaunchOffer,
  setAdminLaunchOffer,
} from "@/lib/admin-launch-offer";
import { adminErrorResponse } from "@/lib/api-route-errors";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

async function handleGET(request: Request) {
  try {
    const response = await getAdminLaunchOffer(bearerTokenFromRequest(request));
    return NextResponse.json(response, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return adminErrorResponse(error, { fallbackMessage: "Offre de lancement indisponible" });
  }
}

async function handlePOST(request: Request) {
  try {
    const authToken = bearerTokenFromRequest(request);
    const input = adminLaunchOfferActionSchema.parse(await request.json());
    const response = await setAdminLaunchOffer({
      authToken,
      input,
    });
    return NextResponse.json(response, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return adminErrorResponse(error, { fallbackMessage: "Offre de lancement non modifiée" });
  }
}

export const GET = withAdminDeadline(handleGET);
export const POST = withAdminDeadline(handlePOST);
