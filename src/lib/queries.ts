import { supabase } from "@/integrations/supabase/client";
import type { AuctionSale, SaleFilters, SortKey, UserAlert } from "./types";

const VIEW = "v_auction_sales_app";

const SORT_MAP: Record<SortKey, { column: string; ascending: boolean; nullsFirst?: boolean }> = {
  date_asc: { column: "sale_date", ascending: true },
  date_desc: { column: "sale_date", ascending: false },
  price_asc: { column: "starting_price_eur", ascending: true },
  price_desc: { column: "starting_price_eur", ascending: false },
  score_desc: { column: "investment_score", ascending: false },
};

export async function getSales(
  filters: SaleFilters = {},
  limit = 100,
  sort: SortKey = "date_asc",
): Promise<AuctionSale[]> {
  const s = SORT_MAP[sort];
  let q = supabase.from(VIEW).select("*").order(s.column, { ascending: s.ascending, nullsFirst: false }).limit(limit);

  if (filters.department) q = q.eq("department", filters.department);
  if (filters.city) q = q.ilike("city", `%${filters.city}%`);
  if (filters.property_type) q = q.eq("property_type", filters.property_type);
  if (filters.max_price != null) q = q.lte("starting_price_eur", filters.max_price);
  if (filters.min_surface != null) q = q.gte("habitable_surface_m2", filters.min_surface);
  if (filters.occupancy_status) q = q.eq("occupancy_status", filters.occupancy_status);
  if (filters.min_score != null) q = q.gte("investment_score", filters.min_score);

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as AuctionSale[];
}

export async function getSaleById(id: string): Promise<AuctionSale | null> {
  const { data, error } = await supabase.from(VIEW).select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data as AuctionSale | null;
}

export async function getSalesWithCoords(limit = 500): Promise<AuctionSale[]> {
  const { data, error } = await supabase
    .from(VIEW)
    .select("*")
    .not("latitude", "is", null)
    .not("longitude", "is", null)
    .order("sale_date", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as AuctionSale[];
}

export async function getStats(): Promise<{ totalSales: number; departments: number; nextSale: string | null }> {
  const { count } = await supabase.from(VIEW).select("*", { count: "exact", head: true });
  const { data: deps } = await supabase.from(VIEW).select("department");
  const uniqueDeps = new Set((deps ?? []).map((r: { department: string | null }) => r.department).filter(Boolean));
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
  const { data: favs, error } = await supabase
    .from("user_favorites")
    .select("sale_id")
    .eq("user_id", userId);
  if (error) throw error;
  const ids = (favs ?? []).map((f: { sale_id: string }) => f.sale_id);
  if (ids.length === 0) return [];
  const { data, error: e2 } = await supabase.from(VIEW).select("*").in("id", ids);
  if (e2) throw e2;
  return (data ?? []) as AuctionSale[];
}

export async function getFavoriteIds(userId: string): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("user_favorites")
    .select("sale_id")
    .eq("user_id", userId);
  if (error) throw error;
  return new Set((data ?? []).map((r: { sale_id: string }) => r.sale_id));
}

export async function addFavorite(userId: string, saleId: string) {
  const { error } = await supabase
    .from("user_favorites")
    .insert({ user_id: userId, sale_id: saleId });
  if (error && !error.message.includes("duplicate")) throw error;
}

export async function removeFavorite(userId: string, saleId: string) {
  const { error } = await supabase
    .from("user_favorites")
    .delete()
    .eq("user_id", userId)
    .eq("sale_id", saleId);
  if (error) throw error;
}

// Alerts
export async function getAlerts(userId: string): Promise<UserAlert[]> {
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
  payload: Omit<UserAlert, "id" | "user_id" | "created_at" | "updated_at" | "is_active"> & { is_active?: boolean },
) {
  const { error } = await supabase.from("user_alerts").insert({
    user_id: userId,
    is_active: true,
    ...payload,
  });
  if (error) throw error;
}

export async function updateAlert(userId: string, alertId: string, patch: Partial<UserAlert>) {
  const { error } = await supabase
    .from("user_alerts")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", alertId)
    .eq("user_id", userId);
  if (error) throw error;
}

export async function deleteAlert(userId: string, alertId: string) {
  const { error } = await supabase
    .from("user_alerts")
    .delete()
    .eq("id", alertId)
    .eq("user_id", userId);
  if (error) throw error;
}