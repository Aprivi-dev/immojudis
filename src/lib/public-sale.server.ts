import { unstable_cache } from "next/cache";
import { cache } from "react";
import { fetchPublicSaleSummary, SALE_ID_PATTERN } from "@/lib/public-sale-summary";
import { createPublicSupabaseClient } from "@/lib/supabase-public.server";
import type { AuctionSale } from "@/lib/types";

export type PublicSaleLookup =
  /** The sale is in the public catalogue: render its page. */
  | { status: "found"; sale: AuctionSale }
  /** No such public sale: answer 404. */
  | { status: "missing" }
  /** The server cannot reach the database (not configured): let the browser decide. */
  | { status: "unavailable" };

const PREVIEW_VIEW = "v_auction_sales_app_preview";

/**
 * Minimal public facts, read from the anonymous preview view. Only used while
 * `get_public_sale_summary` is not deployed on the database yet.
 */
async function legacyPreview(
  client: NonNullable<ReturnType<typeof createPublicSupabaseClient>>,
  id: string,
): Promise<AuctionSale | null> {
  const { data, error } = await client
    .from(PREVIEW_VIEW)
    .select("id,starting_price_eur,sale_venue_type,sale_verification_status")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return (data as AuctionSale | null) ?? null;
}

/**
 * How long the public facts of a sale are served from the data cache before they are
 * re-read. The same value drives `export const revalidate` on `app/sales/[id]/page.tsx`
 * (Next.js requires a literal there, so the page restates it and a test keeps them equal).
 */
export const PUBLIC_SALE_REVALIDATE_SECONDS = 300;

/**
 * Cache tag of one sale. The pipeline invalidates it through
 * `POST /api/pipeline/revalidate-sale` as soon as it changes the sale. Lower-cased because the
 * identifier pattern is case-insensitive and both spellings describe the same sale.
 */
export function publicSaleCacheTag(id: string): string {
  return `sale-${id.toLowerCase()}`;
}

async function readPublicSale(
  client: NonNullable<ReturnType<typeof createPublicSupabaseClient>>,
  id: string,
): Promise<PublicSaleLookup> {
  const summary = await fetchPublicSaleSummary(client, id);
  if (summary.kind === "found") return { status: "found", sale: summary.sale };
  if (summary.kind === "missing") return { status: "missing" };

  const sale = await legacyPreview(client, id);
  return sale ? { status: "found", sale } : { status: "missing" };
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
  return unstable_cache(
    () => readPublicSale(client, normalizedId),
    ["public-sale-lookup", normalizedId],
    { tags: [publicSaleCacheTag(normalizedId)], revalidate: PUBLIC_SALE_REVALIDATE_SECONDS },
  )();
});
