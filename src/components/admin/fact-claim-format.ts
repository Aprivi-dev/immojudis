/** Libellés et mises en forme des observations (`auction_fact_claims`) pour les écrans d'administration. */

const FIELD_LABELS: Record<string, string> = {
  "sale.sale_date": "Date de vente",
  "sale.starting_price_eur": "Mise à prix",
  "sale.visit_dates": "Dates de visite",
  "property.surface_m2": "Surface",
  "property.habitable_surface_m2": "Surface habitable",
  "property.carrez_surface_m2": "Surface Carrez",
  "property.land_surface_m2": "Surface terrain",
  "property.rooms_count": "Nombre de pièces",
  "property.occupancy_status": "Occupation",
};

export function factFieldLabel(fieldKey: string): string {
  return FIELD_LABELS[fieldKey] ?? fieldKey;
}

export function formatFactValue(value: unknown): string {
  if (value == null || value === "") return "—";
  if (typeof value === "number") {
    return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(value);
  }
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "Valeur non affichable";
  }
}

export function formatFactDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Paris",
  }).format(date);
}
