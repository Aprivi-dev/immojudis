import { NextResponse } from "next/server";
import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { PublicApiError } from "@/lib/api-errors";
import { apiRouteError } from "@/lib/api-observability";
import { assertFeatureEntitlementVia } from "@/lib/property-reports";
import { enforceIpRateLimit, enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import {
  pepiteCriteriaPayload,
  pepiteCriteriaViews,
  pepiteDetailPayload,
  pepiteDetailView,
  pepiteFloodView,
  pepiteRegimeOf,
  type PepitePayload,
} from "@/lib/sale-pepite-view";
import { isPublishedPepite, readStoredPepite } from "@/lib/sale-pepite.server";
import { createPublicSupabaseClient } from "@/lib/supabase-public.server";

const saleIdSchema = z.string().guid();

const PRIVATE_HEADERS = { "cache-control": "private, no-store", vary: "authorization" };
/**
 * Les noms des critères sont les mêmes pour tout le monde : le CDN les garde une minute seulement, pour qu'un arrêt
 * d'urgence (`suspend_sale_pepites`) se voie vite (le CDN ne se purge pas par étiquette ici).
 */
const PUBLIC_HEADERS = { "cache-control": "public, s-maxage=60, stale-while-revalidate=30" };

/**
 * Repère « Pépite » d'une vente, à deux niveaux (`?view=`) :
 *
 *  - `criteria` (défaut, ouvert à tous, visiteurs compris) : le NOM des critères réunis, sans valeur ni montant, et
 *    le contrôle du risque d'inondation (verdict affichable et deux dates : jamais un montant) ;
 *  - `detail` : en plus, la condition, le plafond de référence, le prix probable et sa fourchette. Réservé
 *    aux comptes qui ont le droit au plafond d'enchère (offre Analyse, ou vente débloquée avec « 3 déblocages
 *    par mois », comme `/api/market-estimate`) : 401 sans compte, 403 sans le droit. Jamais un montant en dehors
 *    de ce niveau.
 *
 * La vente doit être une pépite publiable À L'INSTANT de l'appel (`get_public_sale_pepite` : mode « on » seulement,
 * mêmes gardes que la liste publique) : sinon 404, y compris en mode « shadow » ou avant la migration. Le droit
 * est vérifié avant la lecture du détail, qui reste dans une table privée lue avec le rôle de service.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const saleId = saleIdSchema.parse((await context.params).id).toLowerCase();
    const detailRequested = new URL(request.url).searchParams.get("view") === "detail";

    if (detailRequested) {
      const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
      await enforceUserRateLimit({
        userId: auth.userId,
        bucketKey: "sale-pepite",
        ...RATE_LIMIT_POLICIES.compute,
      });
      await assertFeatureEntitlementVia(
        auth,
        "property.bidCeiling",
        "Le détail de la pépite est réservé à l’offre Analyse ou à une vente débloquée.",
        { saleId },
      );
    } else {
      await enforceIpRateLimit({
        request,
        bucketKey: "sale-pepite",
        ...RATE_LIMIT_POLICIES.publicIp,
      });
    }

    const client = createPublicSupabaseClient();
    if (!client) throw new Error("Supabase n'est pas configuré côté serveur.");
    if (!(await isPublishedPepite(client, saleId))) {
      throw new PublicApiError("Cette vente n’est pas une pépite.", 404);
    }
    const stored = await readStoredPepite(saleId);
    if (!stored) throw new PublicApiError("Cette vente n’est pas une pépite.", 404);

    const holdMissed = Array.isArray(stored.details.holdMissed)
      ? stored.details.holdMissed.filter((id): id is string => typeof id === "string")
      : [];
    const criteria = pepiteCriteriaViews(
      stored.reasonCodes,
      holdMissed,
      pepiteRegimeOf(stored.details),
    );
    // Le contrôle d'inondation est un fait public sans montant (verdict et deux dates) : il part à tous les niveaux.
    const flood = pepiteFloodView(stored.details);
    if (detailRequested) {
      // Le détail ne part que d'ici, après le droit, et avec l'en-tête privé : jamais de cache partagé.
      const detail = pepiteDetailView(stored.details, stored.evaluatedAt, criteria);
      const body: PepitePayload = detail
        ? pepiteDetailPayload(criteria, detail, flood)
        : pepiteCriteriaPayload(criteria, flood);
      return NextResponse.json(body, { headers: PRIVATE_HEADERS });
    }
    // Le niveau « criteria » ne reçoit JAMAIS le détail : `pepiteCriteriaPayload` ne prend que les critères.
    return NextResponse.json(pepiteCriteriaPayload(criteria, flood), { headers: PUBLIC_HEADERS });
  } catch (error) {
    return apiRouteError(error, request, "sale-pepite", {
      fallbackMessage: "Repère Pépite indisponible.",
    });
  }
}
