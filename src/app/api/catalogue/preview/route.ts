import { PublicApiError } from "@/lib/api-errors";
import { apiError, apiJson, createApiRequestContext } from "@/lib/api-observability";
import {
  DEGRADED_MIRRORS_REVALIDATE_SECONDS,
  FILTERED_SEARCH_REVALIDATE_SECONDS,
  FIRST_PAGE_REVALIDATE_SECONDS,
  isDefaultCatalogueSearch,
  loadPreviewCataloguePage,
  type PreviewCataloguePage,
} from "@/lib/public-catalogue.server";
import { enforceIpRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import {
  parsePreviewSearchRequest,
  type PreviewSearchApiResponse,
} from "@/lib/search/preview-search-request";
import type { SalesSearchParams } from "@/lib/search/search-url-state";

/**
 * Recherche publique d'aperçu du catalogue, pour le navigateur d'un visiteur anonyme : un seul
 * aller-retour sur notre domaine (liste, total et copies de photos) au lieu de deux appels
 * Supabase en série, chacun précédé d'une vérification CORS.
 *
 * La réponse est la même pour tout le monde (mêmes données que le rendu serveur de `/sales`, rien
 * de réservé : voir `buildPreviewSearchArgs`), d'où le cache public du CDN. Les erreurs ne sont
 * jamais mises en cache, et `x-request-id` n'est pas répercuté sur la réponse mise en cache (il
 * serait servi à d'autres visiteurs) : voir `previewCacheControl` pour les durées.
 */
const STALE_WHILE_REVALIDATE_SECONDS = 60;

/**
 * Durée de garde de la réponse par le CDN :
 *  - première page sans filtre : 300 s, comme sa mise en cache de données côté serveur
 *    (`FIRST_PAGE_REVALIDATE_SECONDS`) ; tous les visiteurs la lisent, elle se rafraîchit en tâche
 *    de fond (`stale-while-revalidate`) ;
 *  - recherche filtrée : 120 s (`FILTERED_SEARCH_REVALIDATE_SECONDS`), car c'est là qu'on guette une
 *    nouvelle annonce ; peu de lecteurs par adresse, donc peu de lectures de plus ;
 *  - copies de photos en échec (voir `PreviewCataloguePage.mirrorsDegraded`) : 10 s seulement et
 *    sans `stale-while-revalidate`, pour que le CDN ne fige pas les photos des sources.
 */
function previewCacheControl(search: SalesSearchParams, mirrorsDegraded: boolean): string {
  if (mirrorsDegraded) return `public, s-maxage=${DEGRADED_MIRRORS_REVALIDATE_SECONDS}`;
  const maxAge = isDefaultCatalogueSearch(search)
    ? FIRST_PAGE_REVALIDATE_SECONDS
    : FILTERED_SEARCH_REVALIDATE_SECONDS;
  return `public, s-maxage=${maxAge}, stale-while-revalidate=${STALE_WHILE_REVALIDATE_SECONDS}`;
}

export async function GET(request: Request) {
  const context = createApiRequestContext(request, "api.catalogue.preview");
  try {
    // Les paramètres illisibles sont refusés avant tout accès à la base (et sans consommer de quota).
    const parsed = parsePreviewSearchRequest(new URL(request.url).searchParams);
    if (!parsed.ok) throw new PublicApiError(parsed.message, 400);

    await enforceIpRateLimit({
      request,
      bucketKey: "catalogue.preview",
      ...RATE_LIMIT_POLICIES.catalogPreviewIp,
    });
    const { mirrorsDegraded, ...body }: PreviewCataloguePage = await loadPreviewCataloguePage(
      parsed.search,
    );
    const response: PreviewSearchApiResponse = body;
    return apiJson(
      response,
      context,
      { headers: { "cache-control": previewCacheControl(parsed.search, mirrorsDegraded) } },
      { echoRequestId: false },
    );
  } catch (error) {
    return apiError(error, context, {
      fallbackMessage: "Catalogue indisponible.",
      fallbackStatus: 503,
    });
  }
}
