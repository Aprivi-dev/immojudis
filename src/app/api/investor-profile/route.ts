import { NextResponse } from "next/server";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { apiRouteError } from "@/lib/api-observability";
import { investorProfileInputSchema } from "@/lib/investor-profile-input";
import {
  deleteInvestorProfile,
  getInvestorProfile,
  saveInvestorProfile,
} from "@/lib/investor-profile-store";

// Profil d'investisseur du compte (n° 93) : apport, marge cible, travaux au m², stratégie. Donnée
// personnelle de nature financière : lue et écrite avec le client du compte (RLS « propriétaire
// seul »), jamais mise en cache, jamais envoyée par email.

const PRIVATE_HEADERS = { "cache-control": "private, no-store" };

export async function GET(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const response = await getInvestorProfile({ auth });
    return NextResponse.json(response, { headers: PRIVATE_HEADERS });
  } catch (error) {
    return apiRouteError(error, request, "investor-profile", {
      fallbackMessage: "Profil indisponible",
    });
  }
}

export async function PUT(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = investorProfileInputSchema.parse(await request.json());
    const response = await saveInvestorProfile({ auth, input });
    return NextResponse.json(response, { headers: PRIVATE_HEADERS });
  } catch (error) {
    return apiRouteError(error, request, "investor-profile", {
      fallbackMessage: "Enregistrement du profil impossible",
    });
  }
}

export async function DELETE(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const response = await deleteInvestorProfile({ auth });
    return NextResponse.json(response, { headers: PRIVATE_HEADERS });
  } catch (error) {
    return apiRouteError(error, request, "investor-profile", {
      fallbackMessage: "Effacement du profil impossible",
    });
  }
}
