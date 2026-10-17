import { PublicApiError } from "@/lib/api-errors";
import { apiError, apiJson, createApiRequestContext } from "@/lib/api-observability";
import {
  FIRST_PAGE_REVALIDATE_SECONDS,
  loadPreviewCataloguePage,
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
 * de réservé : voir `buildPreviewSearchArgs`) : le CDN la garde aussi longtemps que la première page
 * du catalogue (`FIRST_PAGE_REVALIDATE_SECONDS`). Les erreurs ne sont jamais mises en cache.
 */
const PREVIEW_CACHE_CONTROL = `public, s-maxage=${FIRST_PAGE_REVALIDATE_SECONDS}, stale-while-revalidate=60`;

export async function GET(request: Request) {
  const context = createApiRequestContext(request, "api.catalogue.preview");
  try {
    // Les paramètres illisibles sont refusés avant tout accès à la base (et sans consommer de quota).
    const parsed = parsePreviewSearchRequest(new URL(request.url).searchParams);
    if (!parsed.ok) throw new PublicApiError(parsed.message, 400);

    await enforceIpRateLimit({
      request,
      bucketKey: "catalogue.preview",
      ...RATE_LIMIT_POLICIES.publicIp,
    });
    const page = await loadPreviewCataloguePage(parsed.search);
    const body: PreviewSearchApiResponse = page;
    return apiJson(body, context, { headers: { "cache-control": PREVIEW_CACHE_CONTROL } });
  } catch (error) {
    return apiError(error, context, {
      fallbackMessage: "Catalogue indisponible.",
      fallbackStatus: 503,
    });
  }
}
