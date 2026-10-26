import { unstable_cache } from "next/cache";
import { apiError, apiJson, createApiRequestContext } from "@/lib/api-observability";
import {
  listPepiteFloodExposedIds,
  listPepiteSaleIds,
  type PepiteFloodIdsClient,
  type PepiteIdsClient,
} from "@/lib/pepite-sale-ids";
import { enforceIpRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import { createPublicSupabaseClient } from "@/lib/supabase-public.server";

/**
 * Liste publique des pépites (`list_public_pepite_sale_ids`) pour le navigateur : les identifiants des ventes
 * publiables, jamais un montant. Un seul appel à la base par instance et par `REVALIDATE_SECONDS` (cache de
 * données de Next), puis le CDN garde la réponse : le filtre « Pépites seulement » et les pastilles des cartes
 * lisent cette liste une fois par page de résultats, jamais une fois par carte.
 *
 * La réponse porte aussi `exposedIds` : parmi ces pépites, celles dont le bien est dans le périmètre d'un plan de
 * prévention des risques d'inondation (mention courte « zonage à vérifier » des cartes), sans montant. Une erreur
 * sur cette seconde liste donne `exposedIds: []` (réponse non gardée, code journalisé), jamais un 503 ni une perte
 * de `ids`.
 *
 * La base ne rend rien tant que le mode des pépites n'est pas « on » : la réponse est alors `{ "ids": [], "exposedIds": [] }`.
 * Fonction absente (migration pas encore appliquée) : même réponse, « aucune pépite » (200). Une panne de la base répond 503, jamais gardée (ni par le cache de données, ni par le CDN).
 */
const REVALIDATE_SECONDS = 300;
/** Une minute au CDN (il ne se purge pas par étiquette) : un arrêt d'urgence se voit vite. */
const CDN_SECONDS = 60;
const PUBLIC_CACHE = `public, s-maxage=${CDN_SECONDS}, stale-while-revalidate=30`;

const cachedPepiteSaleIds = unstable_cache(
  async () => {
    const client = createPublicSupabaseClient();
    if (!client) throw new Error("Supabase n'est pas configuré côté serveur.");
    return listPepiteSaleIds(client as unknown as PepiteIdsClient);
  },
  ["public-catalogue", "pepite-sale-ids", "v2"],
  { revalidate: REVALIDATE_SECONDS, tags: ["public-catalogue"] },
);

/**
 * Liste des pépites « exposées », dans un cache À PART : une erreur ici n'est jamais gardée (le cache de données
 * ne retient pas une exception) et n'affecte jamais `ids`.
 */
const cachedExposedIds = unstable_cache(
  async () => {
    const client = createPublicSupabaseClient();
    if (!client) throw new Error("Supabase n'est pas configuré côté serveur.");
    return listPepiteFloodExposedIds(client as unknown as PepiteFloodIdsClient);
  },
  ["public-catalogue", "pepite-flood-exposed-ids", "v1"],
  { revalidate: REVALIDATE_SECONDS, tags: ["public-catalogue"] },
);

/** Code d'une erreur de la base (`PGRST…`, `57014`…), de quoi journaliser sans donnée. */
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,16}$/.test(code) ? code : "unknown";
}

export async function GET(request: Request) {
  const context = createApiRequestContext(request, "api.catalogue.pepites");
  try {
    await enforceIpRateLimit({
      request,
      bucketKey: "catalogue.pepites",
      ...RATE_LIMIT_POLICIES.catalogPreviewIp,
    });
  } catch (error) {
    // Quota atteint : 429, jamais gardé (le navigateur ne le prend pas pour « aucune pépite »).
    return apiError(error, context, {
      fallbackMessage: "Liste des pépites indisponible.",
      fallbackStatus: 503,
    });
  }
  try {
    const ids = await cachedPepiteSaleIds();
    // La mention « exposée » est un complément : son erreur ne coûte jamais la liste des pépites (`ids`), ni un
    // 503. La réponse dégradée porte `exposedIds: []`, n'est gardée ni par le CDN ni par le cache de données, et
    // l'erreur est journalisée sous forme de code seulement.
    let exposedIds: string[] = [];
    let degraded = false;
    try {
      const published = new Set(ids);
      // Les « exposées » sont une partie des pépites publiables : jamais un identifiant hors de la liste.
      exposedIds = (await cachedExposedIds()).filter((id) => published.has(id));
    } catch (error) {
      degraded = true;
      console.warn(
        JSON.stringify({
          scope: "api.catalogue.pepites",
          event: "flood_exposed_ids_unavailable",
          code: errorCode(error),
        }),
      );
    }
    return apiJson(
      { ids, exposedIds },
      context,
      { headers: { "cache-control": degraded ? "no-store" : PUBLIC_CACHE } },
      { echoRequestId: false },
    );
  } catch (error) {
    // Panne de la base : 503, jamais gardée. Le navigateur ne la prend pas pour « aucune pépite » (il ne met
    // rien en cache et réessaie) ; une base sans la fonction, elle, donne 200 `{ ids: [] }` plus haut.
    return apiError(error, context, {
      fallbackMessage: "Liste des pépites indisponible.",
      fallbackStatus: 503,
    });
  }
}
