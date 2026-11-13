import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { assertAdminAuth } from "@/lib/admin-auth.server";
import { getEmailAddressesReport } from "@/lib/admin-emails/addresses";
import { buildAddressesView } from "@/lib/admin-emails/views";
import { adminRoute } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/**
 * Expéditeurs, secrets (booléens), domaines, DNS et webhooks, déjà mis en forme pour l'affichage.
 * `?refresh=1` : revérifier maintenant.
 */
export const GET = adminRoute(
  { scope: "admin.emails.addresses.read", fallbackMessage: "Adresses d'envoi indisponibles" },
  async (request) => {
    await assertAdminAuth(bearerTokenFromRequest(request));
    const refresh = new URL(request.url).searchParams.get("refresh") === "1";
    return buildAddressesView(await getEmailAddressesReport({ refresh }));
  },
);
