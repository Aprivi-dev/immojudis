import { isLikelyPropertyImageUrl } from "@/lib/sale-media";
import type { AuctionSale } from "@/lib/types";

/**
 * Public (signed-out) facts of ONE sale: what the catalogue card already shows,
 * looked up by identifier. Shared by the server (page, metadata) and the
 * browser (React Query) so both describe a sale the same way.
 */
export const SALE_ID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

type ErrorLike = { code?: string; message?: string } | null;

export type PublicSaleSummaryClient = {
  rpc: (
    fn: "get_public_sale_summary",
    args: { p_sale_id: string },
  ) => PromiseLike<{ data: unknown; error: unknown }>;
};

export type PublicSaleSummaryResult =
  /** The sale is in the public catalogue. */
  | { kind: "found"; sale: AuctionSale }
  /** The sale does not exist or is not publicly visible. */
  | { kind: "missing" }
  /** The database function is not deployed yet: use the minimal legacy preview. */
  | { kind: "unsupported" };

type SummaryRow = {
  id: string;
  starting_price_eur: number | null;
  sale_venue_type: string;
  sale_verification_status: string;
  city: string | null;
  department: string | null;
  property_type: string | null;
  sale_date: string | null;
  app_surface_m2: number | null;
  app_surface_kind: string | null;
  rooms_count: number | null;
  bedrooms_count: number | null;
  bathrooms_count: number | null;
  tribunal_name: string | null;
  tribunal_city: string | null;
  thumbnail_url: string | null;
  updated_at: string | null;
};

function isMissingFunction(error: ErrorLike): boolean {
  if (!error) return false;
  return (
    error.code === "PGRST202" ||
    error.code === "42883" ||
    /get_public_sale_summary/.test(error.message ?? "")
  );
}

export function mapPublicSaleSummary(row: SummaryRow): AuctionSale {
  return {
    id: row.id,
    starting_price_eur: row.starting_price_eur,
    sale_venue_type: row.sale_venue_type,
    sale_verification_status: row.sale_verification_status,
    city: row.city,
    department: row.department,
    property_type: row.property_type,
    sale_date: row.sale_date,
    app_surface_m2: row.app_surface_m2,
    app_surface_kind: row.app_surface_kind,
    rooms_count: row.rooms_count,
    bedrooms_count: row.bedrooms_count,
    bathrooms_count: row.bathrooms_count,
    tribunal_name: row.tribunal_name,
    tribunal_city: row.tribunal_city,
    updated_at: row.updated_at,
    media: isLikelyPropertyImageUrl(row.thumbnail_url)
      ? [{ type: "image", url: row.thumbnail_url }]
      : [],
  } as unknown as AuctionSale;
}

export async function fetchPublicSaleSummary(
  client: PublicSaleSummaryClient,
  id: string,
): Promise<PublicSaleSummaryResult> {
  if (!SALE_ID_PATTERN.test(id)) return { kind: "missing" };
  const { data, error } = await client.rpc("get_public_sale_summary", { p_sale_id: id });
  if (error) {
    if (isMissingFunction(error as ErrorLike)) return { kind: "unsupported" };
    throw error;
  }
  const row = (Array.isArray(data) ? data[0] : data) as SummaryRow | null | undefined;
  return row ? { kind: "found", sale: mapPublicSaleSummary(row) } : { kind: "missing" };
}
