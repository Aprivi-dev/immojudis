import { PLAN_FEATURES, PLAN_LIMITS, type FeatureKey, type PlanCode } from "@/lib/plans";

/**
 * Tableau comparatif Découverte / Analyse. Chaque ligne est calculée à partir des
 * droits réels de src/lib/plans.ts : la page ne peut pas promettre ce que l'offre
 * ne donne pas, ni cacher ce qu'elle donne.
 */
export type OfferCell = { included: boolean; text: string };
export type OfferRow = {
  id: string;
  label: string;
  hint?: string;
  decouverte: OfferCell;
  analyse: OfferCell;
};

type RowSpec = {
  id: string;
  label: string;
  hint?: string;
  /** Droits qui doivent tous être accordés pour que la ligne soit « incluse ». */
  features?: FeatureKey[];
  /** Texte propre à un plan quand les droits ne suffisent pas (quotas). */
  custom?: Partial<Record<PlanCode, string>>;
  includedText?: string;
  limitedText?: string;
};

const SPECS: RowSpec[] = [
  {
    id: "catalogue",
    label: "Catalogue, filtres et fiches des ventes",
    features: ["sales.filters"],
  },
  {
    id: "favorites",
    label: "Favoris",
    features: ["sales.favorites"],
    custom: {
      decouverte: `${PLAN_LIMITS.decouverte.favoriteSales} favoris`,
      analyse: PLAN_LIMITS.analyse.favoriteSales == null ? "Illimités" : undefined,
    },
  },
  {
    id: "alerts",
    label: "Alertes email et zones surveillées",
    hint: "Un seul email récapitulatif par jour ; critères avancés avec Analyse",
    features: ["alerts.advanced", "alerts.watchedZones"],
    custom: {
      decouverte: `${PLAN_LIMITS.decouverte.watchedZones} alerte, ${PLAN_LIMITS.decouverte.watchedZones} zone`,
      analyse: `Jusqu’à ${PLAN_LIMITS.analyse.watchedZones}`,
    },
  },
  { id: "directory", label: "Annuaire des avocats par barreau", features: ["lawyers.directory"] },
  {
    id: "referrals",
    label: "Mise en relation avec un avocat référencé",
    features: ["lawyers.referrals"],
  },
  {
    id: "estimate",
    label: "Estimation du bien et ventes comparables",
    features: ["property.valueEstimate", "property.soldComparables"],
  },
  { id: "ceiling", label: "Enchère plafond chiffrée", features: ["property.bidCeiling"] },
  {
    id: "scenarios",
    label: "Scénarios de frais, de travaux et de marge de sécurité",
    features: ["property.advancedBidScenarios"],
  },
  {
    id: "statistics",
    label: "Statistiques des ventes et des tribunaux",
    features: ["sales.statistics"],
  },
  {
    id: "land",
    label: "Urbanisme, cadastre et risques du terrain",
    features: ["property.cadastralAnalysis", "property.urbanPlanning"],
  },
  { id: "pdf", label: "Rapport PDF du scénario", features: ["property.pdfExport"] },
  { id: "csv", label: "Export CSV des résultats de recherche", features: ["sales.csvExport"] },
];

function cell(plan: PlanCode, spec: RowSpec): OfferCell {
  const levels = (spec.features ?? []).map((feature) => PLAN_FEATURES[plan][feature]);
  const included = levels.length > 0 && levels.every((level) => level !== "locked");
  const custom = spec.custom?.[plan];
  if (custom && included) return { included: true, text: custom };
  return { included, text: included ? (spec.includedText ?? "Inclus") : "Non inclus" };
}

export function offerComparisonRows(): OfferRow[] {
  return SPECS.map((spec) => ({
    id: spec.id,
    label: spec.label,
    hint: spec.hint,
    decouverte: cell("decouverte", spec),
    analyse: cell("analyse", spec),
  }));
}
