import { haversineKm } from "@/lib/geo";
import type { AuctionSale, UserWatchedZone } from "@/lib/types";

export const WATCHED_ZONE_KINDS = [
  "department",
  "city",
  "postal_code",
  "radius",
  "custom",
] as const;

export function watchedZoneMatchesSale(
  zone: Pick<
    UserWatchedZone,
    | "is_active"
    | "zone_kind"
    | "department"
    | "city"
    | "postal_code_prefix"
    | "center_lat"
    | "center_lng"
    | "radius_km"
  >,
  sale: Pick<AuctionSale, "department" | "city" | "postal_code" | "latitude" | "longitude">,
): boolean {
  if (!zone.is_active) return false;

  if (zone.department && normalizeText(sale.department) !== normalizeText(zone.department)) {
    return false;
  }
  if (zone.city && normalizeText(sale.city) !== normalizeText(zone.city)) return false;
  if (
    zone.postal_code_prefix &&
    !normalizePostalCode(sale.postal_code).startsWith(normalizePostalCode(zone.postal_code_prefix))
  ) {
    return false;
  }
  if (zone.zone_kind === "radius" || zone.radius_km != null) {
    if (
      zone.center_lat == null ||
      zone.center_lng == null ||
      zone.radius_km == null ||
      sale.latitude == null ||
      sale.longitude == null
    ) {
      return false;
    }
    const distance = haversineKm(
      { lat: zone.center_lat, lng: zone.center_lng },
      { lat: sale.latitude, lng: sale.longitude },
    );
    if (distance > zone.radius_km) return false;
  }

  return true;
}

export function watchedZoneSummary(zone: Pick<UserWatchedZone, "name" | "zone_kind">): string {
  return zone.zone_kind === "radius" ? `rayon ${zone.name}` : `zone ${zone.name}`;
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function normalizePostalCode(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}
