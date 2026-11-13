import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { apiRoute } from "@/lib/api-route";
import { investorProfileInputSchema } from "@/lib/investor-profile-input";
import {
  deleteInvestorProfile,
  getInvestorProfile,
  saveInvestorProfile,
} from "@/lib/investor-profile-store";

// Profil d'investisseur du compte (n° 93) : apport, marge cible, travaux au m², stratégie. Donnée
// personnelle de nature financière : lue et écrite avec le client service-role, chaque requête
// filtrée sur le compte authentifié (`auth.userId`, voir `investor-profile-store`), jamais mise en
// cache, jamais envoyée par email.

export const GET = apiRoute(
  { scope: "api.investor-profile.read", fallbackMessage: "Profil indisponible" },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    return getInvestorProfile({ auth });
  },
);

export const PUT = apiRoute(
  { scope: "api.investor-profile.save", fallbackMessage: "Enregistrement du profil impossible" },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = investorProfileInputSchema.parse(await request.json());
    return saveInvestorProfile({ auth, input });
  },
);

export const DELETE = apiRoute(
  { scope: "api.investor-profile.delete", fallbackMessage: "Effacement du profil impossible" },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    return deleteInvestorProfile({ auth });
  },
);
