import { PublicApiError } from "@/lib/api-errors";
import { apiError, apiJson, createApiRequestContext } from "@/lib/api-observability";
import {
  DEGRADED_MIRRORS_REVALIDATE_SECONDS,
  loadPreviewCataloguePage,
  type PreviewCataloguePage,
} from "@/lib/public-catalogue.server";
import { enforceIpRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import {
  parsePreviewSearchRequest,
  type PreviewSearchApiResponse,
} from "@/lib/search/preview-search-request";

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
 * Durée de garde de la réponse par le CDN : 60 s, que la recherche soit filtrée ou non.
 *
 * Elle valait 300 s (première page) et 120 s (recherche filtrée) tant qu'on comptait purger ce cache
 * à chaque retrait. La purge par étiquette du CDN de Vercel (`invalidateByTag` de `@vercel/functions`)
 * n'est pas disponible ici : ce paquet n'est pas une dépendance du dépôt (ni dans `node_modules/`).
 * `revalidate-sale` purge donc le cache de données de Next (étiquette `public-catalogue`) et la page
 * `/sales`, mais pas cette réponse du CDN : on borne à la place sa durée de vie. Une vente retirée
 * disparaît de l'aperçu au plus 60 s (+ 60 s de `stale-while-revalidate`, servi une seule fois pendant
 * le rafraîchissement) après la purge du cache de données. Voir
 * docs/runbooks/catalogue-visibility-projection.md pour la suite possible (étiquettes de cache).
 *
 * Copies de photos en échec (voir `PreviewCataloguePage.mirrorsDegraded`) : 10 s seulement et sans
 * `stale-while-revalidate`, pour que le CDN ne fige pas les photos des sources.
 */
const PREVIEW_CDN_MAX_AGE_SECONDS = 60;

function previewCacheControl(mirrorsDegraded: boolean): string {
  if (mirrorsDegraded) return `public, s-maxage=${DEGRADED_MIRRORS_REVALIDATE_SECONDS}`;
  return `public, s-maxage=${PREVIEW_CDN_MAX_AGE_SECONDS}, stale-while-revalidate=${STALE_WHILE_REVALIDATE_SECONDS}`;
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
      { headers: { "cache-control": previewCacheControl(mirrorsDegraded) } },
      { echoRequestId: false },
    );
  } catch (error) {
    return apiError(error, context, {
      fallbackMessage: "Catalogue indisponible.",
      fallbackStatus: 503,
    });
  }
}
