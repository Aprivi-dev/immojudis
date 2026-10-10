import type { SaleDetailTab } from "@/components/sale-detail/SaleDetailTabNav";

const SALE_DETAIL_TABS = [
  "apercu",
  "estimation",
  "statistiques",
  "travaux",
  "financement",
  "demarches",
] as const;
export type LegacyDetail =
  | "market"
  | "budget"
  | "participation"
  | "documents"
  | "professional-pilot"
  | "tribunal-perspective";

export function legacyDetailForAnchor(anchor: string, budgetTarget: string): LegacyDetail | null {
  if (["budget", "budget-analysis", "calculation"].includes(anchor)) {
    return budgetTarget === "budget" ? "budget" : null;
  }
  if (
    ["market", "participation", "documents", "professional-pilot", "tribunal-perspective"].includes(
      anchor,
    )
  ) {
    return anchor as LegacyDetail;
  }
  return null;
}

export function isTabAnchor(anchor: string): anchor is SaleDetailTab {
  return SALE_DETAIL_TABS.includes(anchor as SaleDetailTab);
}

export function tabForAnchor(anchor: string, allowStatistics = true): SaleDetailTab {
  return knownTabForAnchor(anchor, allowStatistics) ?? "apercu";
}

export function knownTabForAnchor(anchor: string, allowStatistics = true): SaleDetailTab | null {
  if (
    [
      "statistiques",
      "tribunal-history",
      "stats-overview",
      "stats-ventes",
      "stats-chiffres",
      "stats-adjudications",
      "stats-calendrier",
      "stats-avocats",
      "stats-communes",
      "stats-methode",
    ].includes(anchor)
  )
    return allowStatistics ? "statistiques" : "apercu";
  if (isTabAnchor(anchor)) return anchor;
  if (
    ["market", "budget", "budget-analysis", "summary", "calculation", "why-this-ceiling"].includes(
      anchor,
    )
  ) {
    return "estimation";
  }
  if (anchor === "tribunal-perspective") return "estimation";
  if (anchor === "works") return "travaux";
  if (anchor === "financing") return "financement";
  if (
    ["rendez-vous", "participation", "documents", "lawyer", "professional-pilot"].includes(anchor)
  ) {
    return "demarches";
  }
  if (["description-ia", "localisation", "urbanism", "risks"].includes(anchor)) {
    return "apercu";
  }
  return null;
}

export function revealAnchor(anchor: string, budgetTarget: string) {
  const fallback = ["budget", "budget-analysis", "calculation"].includes(anchor)
    ? budgetTarget
    : ["market", "tribunal-perspective", "why-this-ceiling"].includes(anchor)
      ? "summary"
      : tabForAnchor(anchor) === "travaux"
        ? "sale-detail-panel-travaux"
        : tabForAnchor(anchor) === "statistiques"
          ? "sale-detail-panel-statistiques"
          : tabForAnchor(anchor) === "demarches"
            ? "sale-detail-panel-demarches"
            : null;
  const target = document.getElementById(anchor) ?? (fallback && document.getElementById(fallback));
  if (!target) return;
  let parent = target.closest("details");
  while (parent) {
    parent.open = true;
    parent = parent.parentElement?.closest("details") ?? null;
  }
  target.scrollIntoView?.({ block: "start" });
}
