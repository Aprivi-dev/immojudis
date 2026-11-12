import { unstable_cache } from "next/cache";
import { cache } from "react";
import { fetchPublicSaleSummary, SALE_ID_PATTERN } from "@/lib/public-sale-summary";
import { withPhotoMirror, type PhotoMirrorClient } from "@/lib/photo-mirror";
import { cachedPhotoMirrorFetcher } from "@/lib/photo-mirror.server";
import { createPublicSupabaseClient } from "@/lib/supabase-public.server";
import {
  fetchLawyerFactSources,
  warnLawyerFactSourcesFailure,
  withLawyerFactSources,
  type LawyerFactSource,
} from "@/lib/lawyer-fact-sources";
import { loadWithdrawnSources } from "@/lib/withdrawn-sources";
import type { AuctionSale } from "@/lib/types";

export type PublicSaleLookup =
  /** The sale is in the public catalogue: render its page. */
  | {
      status: "found";
      sale: AuctionSale;
      /** Database verdict on indexing; absent for an answer outside the contract. */
      indexable?: boolean;
    }
  /**
   * The identifier belongs to a sale that was merged into another one (duplicate merge) and the
   * kept sale is in the public catalogue: answer with a permanent redirect to `targetId`.
   */
  | { status: "merged"; targetId: string }
  /** No such public sale: answer 404. */
  | { status: "missing" }
  /** The server cannot reach the database (not configured): let the browser decide. */
  | { status: "unavailable" };

type MergedSaleClient = {
  rpc: (
    fn: "get_merged_sale_target",
    args: { p_sale_id: string },
  ) => PromiseLike<{ data: unknown; error: unknown }>;
};

/**
 * The kept sale of an identifier that a duplicate merge removed (`get_merged_sale_target`: the
 * identifier only, and only when the kept sale is visible in the public catalogue), or `null`.
 */
async function fetchMergedSaleTarget(
  client: NonNullable<ReturnType<typeof createPublicSupabaseClient>>,
  id: string,
): Promise<string | null> {
  const { data, error } = await (client as unknown as MergedSaleClient).rpc(
    "get_merged_sale_target",
    { p_sale_id: id },
  );
  if (error) throw error;
  if (typeof data !== "string" || !SALE_ID_PATTERN.test(data)) return null;
  const targetId = data.toLowerCase();
  return targetId === id ? null : targetId;
}

/**
 * How long the public facts of a sale are served from the data cache before they are
 * re-read. The same value drives `export const revalidate` on `app/sales/[id]/page.tsx`
 * (Next.js requires a literal there, so the page restates it and a test keeps them equal).
 */
export const PUBLIC_SALE_REVALIDATE_SECONDS = 3600;

/**
 * Cache tag of one sale. The pipeline invalidates it through
 * `POST /api/pipeline/revalidate-sale` as soon as it changes the sale. Lower-cased because the
 * identifier pattern is case-insensitive and both spellings describe the same sale.
 */
/**
 * Tag shared by EVERY cached public sale lookup: expiring it refreshes all the public pages at once (used by the
 * emergency stop of the pepites, whose mark is read with the sale). `publicSaleCacheTag` stays the per-sale tag.
 */
export const PUBLIC_SALES_CACHE_TAG = "public-sales";

export function publicSaleCacheTag(id: string): string {
  return `sale-${id.toLowerCase()}`;
}

async function readPublicSale(
  client: NonNullable<ReturnType<typeof createPublicSupabaseClient>>,
  id: string,
): Promise<PublicSaleLookup> {
  // Le contenu d'une source retirée (photo d'une vente fusionnée) ne sort pas, y compris côté serveur.
  await loadWithdrawnSources(client);
  const summary = await fetchPublicSaleSummary(client, id, { withIndexability: true });
  if (summary.kind === "missing") return missingOrMerged(client, id);
  return {
    status: "found",
    sale: summary.sale,
    ...(summary.indexable === undefined ? {} : { indexable: summary.indexable }),
  };
}

/** A sale that is not public: a merged duplicate redirects to the sale that was kept, else 404. */
async function missingOrMerged(
  client: NonNullable<ReturnType<typeof createPublicSupabaseClient>>,
  id: string,
): Promise<PublicSaleLookup> {
  const targetId = await fetchMergedSaleTarget(client, id);
  return targetId ? { status: "merged", targetId } : { status: "missing" };
}

/**
 * Looks a sale up the way a signed-out visitor sees it.
 *
 * Two layers of memoization:
 * - React `cache`: per request, so `generateMetadata` and the page share one lookup;
 * - the Next.js data cache (`unstable_cache`): across requests and visitors, for
 *   {@link PUBLIC_SALE_REVALIDATE_SECONDS}, tagged `sale-<id>` for on-demand invalidation.
 *   This keeps a public sale to ONE database read even when the page itself is rendered
 *   per request (nonce-based CSP enforced) or revalidated in the background.
 *
 * A database error is thrown (500, retried by crawlers) rather than reported as
 * "missing": a transient failure must never turn a real sale into a 404. Thrown errors
 * and the "unavailable" answer (no database configured) are never stored in the cache.
 */
export const lookupPublicSale = cache(async (id: string): Promise<PublicSaleLookup> => {
  if (!SALE_ID_PATTERN.test(id)) return { status: "missing" };
  const client = createPublicSupabaseClient();
  if (!client) return { status: "unavailable" };

  const normalizedId = id.toLowerCase();
  const lookup = await unstable_cache(
    () => readPublicSale(client, normalizedId),
    ["public-sale-lookup", normalizedId],
    {
      tags: [publicSaleCacheTag(normalizedId), PUBLIC_SALES_CACHE_TAG],
      revalidate: PUBLIC_SALE_REVALIDATE_SECONDS,
    },
  )();
  if (lookup.status !== "found") return lookup;
  // Copie hébergée de la photo : cherchée après le cache de la vente, pour qu'un échec ou un délai
  // dépassé ne reste pas cinq minutes. Seules les 3 premières photos affichées sont cherchées, et
  // les copies trouvées ont leur propre cache (photo-mirror.server.ts). Jamais bloquant ni visible.
  const mirrorClient = client as unknown as PhotoMirrorClient;
  const [mirrored, lawyerSources] = await Promise.all([
    withPhotoMirror(lookup.sale, mirrorClient, {
      fetchMirrors: cachedPhotoMirrorFetcher(mirrorClient),
    }),
    cachedLawyerFactSources(client, normalizedId),
  ]);
  const sale = withLawyerFactSources(mirrored, lawyerSources);
  return sale === lookup.sale ? lookup : { ...lookup, sale };
});

/**
 * Valeurs de la fiche transmises par l'avocat poursuivant : lues seulement pour une vente trouvée (ni pour
 * un identifiant absent ni pour un identifiant fusionné), avec le même cache et les mêmes étiquettes que la
 * vente. Une lecture en échec n'est jamais mise en cache comme « aucune mention » : l'erreur traverse le
 * cache (qui ne garde pas les erreurs), elle est tracée avec son code seul et la page s'affiche sans
 * mention ; la lecture suivante réessaie.
 */
async function cachedLawyerFactSources(
  client: NonNullable<ReturnType<typeof createPublicSupabaseClient>>,
  id: string,
): Promise<LawyerFactSource[]> {
  try {
    return await unstable_cache(
      () => fetchLawyerFactSources(client, id),
      ["public-sale-lawyer-fact-sources", id],
      {
        tags: [publicSaleCacheTag(id), PUBLIC_SALES_CACHE_TAG],
        revalidate: PUBLIC_SALE_REVALIDATE_SECONDS,
      },
    )();
  } catch (error) {
    warnLawyerFactSourcesFailure(error);
    return [];
  }
}
