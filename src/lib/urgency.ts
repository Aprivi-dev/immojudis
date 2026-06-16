// Couleur et compte à rebours d'« urgence » d'une vente (jours avant l'audience),
// partagés entre la carte (pins) et la liste de résultats synchronisée.

export function daysUntil(date: string | null | undefined): number | null {
  if (!date) return null;
  const t = new Date(date).getTime();
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / 86_400_000);
}

export type UrgencyColor = { bg: string; ring: string; label: string };

export function urgencyColor(date: string | null | undefined): UrgencyColor {
  const d = daysUntil(date);
  if (d == null) return { bg: "#9ca3af", ring: "#6b7280", label: "?" };
  if (d < 0) return { bg: "#6b7280", ring: "#4b5563", label: "—" };
  const label = d > 99 ? "99+" : String(d);
  if (d < 7) return { bg: "#dc2626", ring: "#991b1b", label };
  if (d < 30) return { bg: "#d97706", ring: "#92400e", label };
  return { bg: "#0f9d6e", ring: "#047857", label };
}
