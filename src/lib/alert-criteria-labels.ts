import { formatDate, formatPrice, occupancyLabel, propertyTypeLabel } from "@/lib/format";
import { parseSaleType, saleTypeFilterLabel } from "@/lib/sale-types";
import type { UserAlert } from "@/lib/types";

export type AlertFrequency = "daily" | "weekly";

export const ALERT_FREQUENCY_LABELS: Record<AlertFrequency, string> = {
  daily: "Quotidienne",
  weekly: "Hebdomadaire",
};

/** « Immédiate » n'existe pas côté serveur : elle est traitée comme quotidienne. */
export function normalizeAlertFrequency(value: UserAlert["alert_frequency"]): AlertFrequency {
  return value === "weekly" ? "weekly" : "daily";
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Les critères d'une alerte en phrases simples, dans l'ordre où on les cherche. */
export function alertCriteriaSummary(
  alert: Pick<
    UserAlert,
    | "department"
    | "city"
    | "property_type"
    | "max_price_eur"
    | "min_surface_m2"
    | "occupancy_status"
    | "min_investment_score"
    | "max_price_per_m2"
    | "min_yield_pct"
    | "min_market_discount_pct"
    | "dpe_classes"
    | "require_house_with_land"
    | "advanced_criteria"
  >,
): string[] {
  const criteria: string[] = [];
  const advanced = alert.advanced_criteria ?? {};

  const place = [alert.city, alert.department].filter(Boolean).join(", ") || text(advanced.query);
  if (place) criteria.push(`Lieu : ${place}`);
  const around = text(advanced.around_address);
  if (around) {
    const radius = number(advanced.around_radius_km);
    criteria.push(`Autour de ${around}${radius ? ` (${radius} km)` : ""}`);
  }
  const saleType = parseSaleType(advanced.sale_type);
  if (saleType) criteria.push(`Vente : ${saleTypeFilterLabel(saleType).toLowerCase()}`);
  if (alert.property_type) criteria.push(`Bien : ${propertyTypeLabel(alert.property_type)}`);
  if (alert.max_price_eur != null) {
    criteria.push(`Mise à prix maximale : ${formatPrice(alert.max_price_eur)}`);
  }
  if (alert.min_surface_m2 != null) criteria.push(`Surface minimale : ${alert.min_surface_m2} m²`);
  if (alert.max_price_per_m2 != null) {
    criteria.push(`Prix maximal : ${formatPrice(alert.max_price_per_m2)} par m²`);
  }
  if (alert.occupancy_status)
    criteria.push(`Occupation : ${occupancyLabel(alert.occupancy_status)}`);
  if (alert.min_yield_pct != null) criteria.push(`Rendement minimal : ${alert.min_yield_pct} %`);
  if (alert.min_market_discount_pct != null) {
    criteria.push(`Décote minimale : ${alert.min_market_discount_pct} %`);
  }
  if (alert.min_investment_score != null) {
    criteria.push(`Note minimale : ${alert.min_investment_score} sur 100`);
  }
  if (alert.dpe_classes?.length) criteria.push(`DPE : ${alert.dpe_classes.join(", ")}`);
  if (alert.require_house_with_land) criteria.push("Maison avec terrain");
  const from = text(advanced.min_sale_date);
  const to = text(advanced.max_sale_date);
  if (from || to) {
    criteria.push(
      from && to
        ? `Audience entre le ${formatDate(from)} et le ${formatDate(to)}`
        : from
          ? `Audience à partir du ${formatDate(from)}`
          : `Audience jusqu'au ${formatDate(to)}`,
    );
  }
  return criteria;
}
