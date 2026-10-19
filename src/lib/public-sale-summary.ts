import { isPublicMarketGapBand, type PublicMarketGapBand } from "@/lib/market-gap-band";
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
    fn:
      | "get_public_sale_summary"
      | "get_public_sale_details"
      | "get_public_sale_indexability"
      | "get_public_sale_market_gap_band",
    args: { p_sale_id: string },
  ) => PromiseLike<{ data: unknown; error: unknown }>;
};

export type PublicSaleSummaryResult =
  /** The sale is in the public catalogue. */
  | {
      kind: "found";
      sale: AuctionSale;
      /**
       * Verdict of the database on whether the page may be indexed (only when asked for and the
       * function is deployed). `undefined`: decide with `isIndexablePublicSale`.
       */
      indexable?: boolean;
    }
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
  /** Date of the last visible change; absent while the database function is not migrated yet. */
  content_changed_at?: string | null;
};

/**
 * Extra facts of the signed-out page (land, amenities, whether visits are
 * organised, how many photos and documents the full listing holds). The visit
 * text, the address and the documents themselves stay reserved to accounts.
 */
type DetailsRow = {
  land_surface_m2: number | null;
  parking_count: number | null;
  has_garden: boolean | null;
  has_terrace: boolean | null;
  has_garage: boolean | null;
  has_pool: boolean | null;
  has_air_conditioning: boolean | null;
  has_double_glazing: boolean | null;
  has_visit_dates: boolean | null;
  photo_count: number | null;
  document_count: number | null;
};

function isMissingFunction(error: ErrorLike, fn = "get_public_sale_summary"): boolean {
  if (!error) return false;
  return (
    error.code === "PGRST202" || error.code === "42883" || new RegExp(fn).test(error.message ?? "")
  );
}

export function mapPublicSaleDetails(row: DetailsRow): Partial<AuctionSale> {
  return {
    land_surface_m2: row.land_surface_m2,
    parking_count: row.parking_count,
    has_garden: row.has_garden,
    has_terrace: row.has_terrace,
    has_garage: row.has_garage,
    has_pool: row.has_pool,
    has_air_conditioning: row.has_air_conditioning,
    has_double_glazing: row.has_double_glazing,
    has_visit_dates: row.has_visit_dates,
    photo_count: row.photo_count,
    document_count: row.document_count,
  } as Partial<AuctionSale>;
}

/** The details are an enrichment: a database without the function keeps the summary alone. */
async function fetchPublicSaleDetails(
  client: PublicSaleSummaryClient,
  id: string,
): Promise<Partial<AuctionSale>> {
  const { data, error } = await client.rpc("get_public_sale_details", { p_sale_id: id });
  if (error) {
    if (isMissingFunction(error as ErrorLike, "get_public_sale_details")) return {};
    throw error;
  }
  const row = (Array.isArray(data) ? data[0] : data) as DetailsRow | null | undefined;
  return row ? mapPublicSaleDetails(row) : {};
}

/**
 * The database's own verdict (`app_private.is_indexable_public_sale`, the predicate the sitemap
 * uses too), or `undefined` while the function is not deployed.
 */
async function fetchPublicSaleIndexability(
  client: PublicSaleSummaryClient,
  id: string,
): Promise<boolean | undefined> {
  const { data, error } = await client.rpc("get_public_sale_indexability", { p_sale_id: id });
  if (error) {
    if (isMissingFunction(error as ErrorLike, "get_public_sale_indexability")) return undefined;
    throw error;
  }
  return typeof data === "boolean" ? data : undefined;
}

/**
 * Écart de la mise à prix au marché local, en trois bandes (`get_public_sale_market_gap_band`), ou
 * `undefined` : fonction pas encore déployée, erreur, ou réponse hors contrat. C'est un
 * enrichissement : sa panne ne change ni la fiche ni son statut, elle supprime seulement la bande
 * (jamais un chiffre à la place). Une base qui n'a rien à dire répond `null`.
 */
async function fetchPublicSaleMarketGapBand(
  client: PublicSaleSummaryClient,
  id: string,
): Promise<PublicMarketGapBand | undefined> {
  try {
    const { data, error } = await client.rpc("get_public_sale_market_gap_band", { p_sale_id: id });
    if (error) return undefined;
    return isPublicMarketGapBand(data) ? data : undefined;
  } catch {
    return undefined;
  }
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
    content_changed_at: row.content_changed_at ?? null,
    media: isLikelyPropertyImageUrl(row.thumbnail_url)
      ? [{ type: "image", url: row.thumbnail_url }]
      : [],
  } as unknown as AuctionSale;
}

export async function fetchPublicSaleSummary(
  client: PublicSaleSummaryClient,
  id: string,
  options: { withIndexability?: boolean } = {},
): Promise<PublicSaleSummaryResult> {
  if (!SALE_ID_PATTERN.test(id)) return { kind: "missing" };
  const [{ data, error }, details, indexable, marketGapBand] = await Promise.all([
    client.rpc("get_public_sale_summary", { p_sale_id: id }),
    fetchPublicSaleDetails(client, id),
    options.withIndexability ? fetchPublicSaleIndexability(client, id) : undefined,
    fetchPublicSaleMarketGapBand(client, id),
  ]);
  if (error) {
    if (isMissingFunction(error as ErrorLike)) return { kind: "unsupported" };
    throw error;
  }
  const row = (Array.isArray(data) ? data[0] : data) as SummaryRow | null | undefined;
  return row
    ? {
        kind: "found",
        sale: {
          ...mapPublicSaleSummary(row),
          ...details,
          ...(marketGapBand === undefined ? {} : { market_gap_band: marketGapBand }),
        },
        ...(indexable === undefined ? {} : { indexable }),
      }
    : { kind: "missing" };
}
