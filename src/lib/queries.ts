import { isSupabaseConfigured, supabase } from "@/integrations/supabase/client";
import type { AuctionSale, SaleFilters, SortKey, UserAlert } from "./types";

const VIEW = "v_auction_sales_app";
const CONFIGURATION_ERROR =
  "La configuration Supabase est absente. Ajoutez les variables d'environnement Supabase pour afficher les données.";

const SALE_LIST_COLUMNS = [
  "id",
  "title",
  "city",
  "department",
  "postal_code",
  "property_type",
  "starting_price_eur",
  "sale_date",
  "latitude",
  "longitude",
  "occupancy_status",
  "habitable_surface_m2",
  "carrez_surface_m2",
  "app_surface_m2",
  "rooms_count",
  "bedrooms_count",
  "has_garden",
  "has_terrace",
  "has_garage",
  "has_pool",
  "has_air_conditioning",
  "has_double_glazing",
  "investment_score",
  "score_confidence",
  "surface_confidence",
  "risks",
  "documents",
  "source_url",
  "status",
  "created_at",
].join(",");

function assertCloudConfigured() {
  if (isSupabaseConfigured) return true;
  // On the SSR worker the env may not be hydrated yet — return false so
  // callers can short-circuit with empty results and let the browser
  // refetch once the user session and env are available.
  if (typeof window === "undefined") return false;
  throw new Error(CONFIGURATION_ERROR);
}

const SORT_MAP: Record<SortKey, { column: string; ascending: boolean; nullsFirst?: boolean }> = {
  date_asc: { column: "sale_date", ascending: true },
  date_desc: { column: "sale_date", ascending: false },
  price_asc: { column: "starting_price_eur", ascending: true },
  price_desc: { column: "starting_price_eur", ascending: false },
  score_desc: { column: "investment_score", ascending: false },
  surface_desc: { column: "app_surface_m2", ascending: false },
};

export async function getSales(
  filters: SaleFilters = {},
  limit = 100,
  sort: SortKey = "date_asc",
  offset = 0,
): Promise<AuctionSale[]> {
  if (!assertCloudConfigured()) return [];
  const s = SORT_MAP[sort];
  let q = supabase
    .from(VIEW)
    .select(SALE_LIST_COLUMNS)
    .order(s.column, { ascending: s.ascending, nullsFirst: false })
    .range(offset, offset + limit - 1);

  if (filters.department) q = q.eq("department", filters.department);
  if (filters.city) q = q.ilike("city", `%${filters.city}%`);
  if (filters.property_type) q = q.eq("property_type", filters.property_type);
  if (filters.max_price != null) q = q.lte("starting_price_eur", filters.max_price);
  if (filters.min_surface != null) q = q.gte("app_surface_m2", filters.min_surface);
  if (filters.occupancy_status) q = q.eq("occupancy_status", filters.occupancy_status);
  if (filters.min_score != null) q = q.gte("investment_score", filters.min_score);
  if (filters.tribunal_code) q = q.eq("tribunal_code", filters.tribunal_code);
  if (filters.only_new) {
    q = q.gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
  }

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as AuctionSale[];
}

export async function getSaleById(id: string): Promise<AuctionSale | null> {
  if (!assertCloudConfigured()) return null;
  const { data, error } = await supabase.from(VIEW).select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data as AuctionSale | null;
}

export async function getSalesWithCoords(limit = 500): Promise<AuctionSale[]> {
  if (!assertCloudConfigured()) return [];
  const { data, error } = await supabase
    .from(VIEW)
    .select(SALE_LIST_COLUMNS)
    .not("latitude", "is", null)
    .not("longitude", "is", null)
    .order("sale_date", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as unknown as AuctionSale[];
}

/**
 * Fetch sales within a bounding box around (lat,lng).
 * radiusKm is the half-side of the bbox; the caller is expected to filter
 * by exact haversine distance afterwards if needed.
 */
export async function getNearbySales(
  lat: number,
  lng: number,
  radiusKm: number,
  excludeId?: string,
  limit = 50,
): Promise<AuctionSale[]> {
  if (!assertCloudConfigured()) return [];
  // 1° latitude ≈ 111 km. 1° longitude ≈ 111 km × cos(lat).
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  let q = supabase
    .from(VIEW)
    .select(SALE_LIST_COLUMNS)
    .gte("latitude", lat - dLat)
    .lte("latitude", lat + dLat)
    .gte("longitude", lng - dLng)
    .lte("longitude", lng + dLng)
    .order("sale_date", { ascending: true })
    .limit(limit);
  if (excludeId) q = q.neq("id", excludeId);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as AuctionSale[];
}

export async function getStats(): Promise<{
  totalSales: number;
  departments: number;
  nextSale: string | null;
}> {
  if (!assertCloudConfigured()) return { totalSales: 0, departments: 0, nextSale: null };
  const { count } = await supabase.from(VIEW).select("*", { count: "exact", head: true });
  const { data: deps } = await supabase
    .from(VIEW)
    .select("department")
    .not("department", "is", null)
    .limit(1000);
  const uniqueDeps = new Set(
    (deps ?? []).map((r: { department: string | null }) => r.department).filter(Boolean),
  );
  const { data: next } = await supabase
    .from(VIEW)
    .select("sale_date")
    .gte("sale_date", new Date().toISOString())
    .order("sale_date", { ascending: true })
    .limit(1);
  return {
    totalSales: count ?? 0,
    departments: uniqueDeps.size,
    nextSale: next?.[0]?.sale_date ?? null,
  };
}

// Favorites
export async function getFavorites(userId: string): Promise<AuctionSale[]> {
  if (!assertCloudConfigured()) return [];
  const { data: favs, error } = await supabase
    .from("user_favorites")
    .select("sale_id")
    .eq("user_id", userId);
  if (error) throw error;
  const ids = (favs ?? []).map((f: { sale_id: string }) => f.sale_id);
  if (ids.length === 0) return [];
  const { data, error: e2 } = await supabase.from(VIEW).select(SALE_LIST_COLUMNS).in("id", ids);
  if (e2) throw e2;
  return (data ?? []) as unknown as AuctionSale[];
}

export async function getFavoriteIds(userId: string): Promise<Set<string>> {
  if (!assertCloudConfigured()) return new Set();
  const { data, error } = await supabase
    .from("user_favorites")
    .select("sale_id")
    .eq("user_id", userId);
  if (error) throw error;
  return new Set((data ?? []).map((r: { sale_id: string }) => r.sale_id));
}

export async function addFavorite(userId: string, saleId: string) {
  assertCloudConfigured();
  const { error } = await supabase
    .from("user_favorites")
    .insert({ user_id: userId, sale_id: saleId });
  if (error && !error.message.includes("duplicate")) throw error;
}

export async function removeFavorite(userId: string, saleId: string) {
  assertCloudConfigured();
  const { error } = await supabase
    .from("user_favorites")
    .delete()
    .eq("user_id", userId)
    .eq("sale_id", saleId);
  if (error) throw error;
}

// Alerts
export async function getAlerts(userId: string): Promise<UserAlert[]> {
  if (!assertCloudConfigured()) return [];
  const { data, error } = await supabase
    .from("user_alerts")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as UserAlert[];
}

export async function createAlert(
  userId: string,
  payload: Omit<UserAlert, "id" | "user_id" | "created_at" | "updated_at" | "is_active"> & {
    is_active?: boolean;
  },
) {
  assertCloudConfigured();
  const { error } = await supabase.from("user_alerts").insert({
    user_id: userId,
    is_active: true,
    ...payload,
  });
  if (error) throw error;
}

export async function updateAlert(userId: string, alertId: string, patch: Partial<UserAlert>) {
  assertCloudConfigured();
  const { error } = await supabase
    .from("user_alerts")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", alertId)
    .eq("user_id", userId);
  if (error) throw error;
}

export async function deleteAlert(userId: string, alertId: string) {
  assertCloudConfigured();
  const { error } = await supabase
    .from("user_alerts")
    .delete()
    .eq("id", alertId)
    .eq("user_id", userId);
  if (error) throw error;
}
