import type { SaleFilters } from "./types";

export function filtersFromSearchParams(sp: URLSearchParams): SaleFilters {
  const f: SaleFilters = {};
  const dep = sp.get("department");
  if (dep) f.department = dep;
  const city = sp.get("city");
  if (city) f.city = city;
  const t = sp.get("type");
  if (t) f.property_type = t;
  const maxPrice = sp.get("max_price");
  if (maxPrice && !isNaN(Number(maxPrice))) f.max_price = Number(maxPrice);
  const minSurface = sp.get("min_surface");
  if (minSurface && !isNaN(Number(minSurface))) f.min_surface = Number(minSurface);
  const occ = sp.get("occupancy");
  if (occ) f.occupancy_status = occ;
  const minScore = sp.get("min_score");
  if (minScore && !isNaN(Number(minScore))) f.min_score = Number(minScore);
  return f;
}

export function searchParamsFromFilters(f: SaleFilters): URLSearchParams {
  const sp = new URLSearchParams();
  if (f.department) sp.set("department", f.department);
  if (f.city) sp.set("city", f.city);
  if (f.property_type) sp.set("type", f.property_type);
  if (f.max_price != null) sp.set("max_price", String(f.max_price));
  if (f.min_surface != null) sp.set("min_surface", String(f.min_surface));
  if (f.occupancy_status) sp.set("occupancy", f.occupancy_status);
  if (f.min_score != null) sp.set("min_score", String(f.min_score));
  return sp;
}
