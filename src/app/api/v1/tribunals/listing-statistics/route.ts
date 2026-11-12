import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { PublicApiError, parseApiResponse } from "@/lib/api-errors";
import { apiRoute } from "@/lib/api-route";
import { assertFeatureEntitlementVia } from "@/lib/property-reports";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import {
  tribunalListingStatisticsQuerySchema,
  tribunalListingStatisticsResponseSchema,
} from "@/lib/tribunal-listing-statistics";
import { getTribunalListingStatistics } from "@/lib/tribunal-listing-statistics-repository";

export const GET = apiRoute(
  {
    scope: "tribunal.listing_statistics",
    fallbackMessage: "Statistiques des annonces du tribunal temporairement indisponibles.",
    fallbackStatus: 503,
    versionedApi: true,
  },
  async (request, { api }) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      context: api,
      bucketKey: "v1.tribunal-listing-statistics",
      ...RATE_LIMIT_POLICIES.compute,
    });
    const url = new URL(request.url);
    // One reading of the query serves both the entitlement and the data. A repeated parameter
    // (`?saleId=U&saleId=V`) would be read as the first value by one and the last by the other, so
    // an unlock of U could open the tribunal of V: it is refused.
    for (const name of new Set(url.searchParams.keys())) {
      if (url.searchParams.getAll(name).length > 1) {
        throw new PublicApiError("Requête invalide : paramètre répété.", 400);
      }
    }
    const query = Object.fromEntries(url.searchParams.entries());
    // Analyse, or a Découverte account that unlocked the sale given as `saleId` (« 3 déblocages
    // par mois »): the tribunal of that sale only. A query by `courtCode` stays on Analyse. The
    // query is validated after the entitlement, as before; the schema then requires exactly one of
    // `courtCode` and `saleId`.
    const { door } = await assertFeatureEntitlementVia(
      auth,
      "sales.statistics",
      "Statistiques des annonces judiciaires réservées à l’offre Analyse.",
      { saleId: z.string().guid().safeParse(query.saleId).data },
    );
    const input = tribunalListingStatisticsQuerySchema.parse(query);
    const statistics = parseApiResponse(
      tribunalListingStatisticsResponseSchema,
      await getTribunalListingStatistics(input),
    );
    // An unlock opens the statistics of the tribunal, not the list of its other upcoming sales
    // (title, city, occupation, visit): that list stays with Analyse. The page does not show it
    // to an unlocked account either.
    if (door === "unlock") statistics.activity.upcomingListings = [];
    return statistics;
  },
);
