import { cache } from "react";
import {
  fetchPublicSaleSummary,
  SALE_ID_PATTERN,
  type PublicSaleSummaryClient,
} from "@/lib/public-sale-summary";
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
  return (data as unknown as AuctionSale | null) ?? null;
}

/**
 * Looks a sale up the way a signed-out visitor sees it. Memoized per request so
 * `generateMetadata` and the page share a single database round trip.
 *
 * A database error is thrown (500, retried by crawlers) rather than reported as
 * "missing": a transient failure must never turn a real sale into a 404.
 */
export const lookupPublicSale = cache(async (id: string): Promise<PublicSaleLookup> => {
  if (!SALE_ID_PATTERN.test(id)) return { status: "missing" };
  const client = createPublicSupabaseClient();
  if (!client) return { status: "unavailable" };

  const summary = await fetchPublicSaleSummary(client as unknown as PublicSaleSummaryClient, id);
  if (summary.kind === "found") return { status: "found", sale: summary.sale };
  if (summary.kind === "missing") return { status: "missing" };

  const sale = await legacyPreview(client, id);
  return sale ? { status: "found", sale } : { status: "missing" };
});
