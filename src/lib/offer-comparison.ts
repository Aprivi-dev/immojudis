import {
  ceilingTermText,
  ceilingTermWithScopeText,
  ceilingVenueScopeText,
} from "@/lib/fee-regime-labels";
import type { FeeRegimeKey } from "@/lib/fee-regime-open";
import {
  isSaleUnlockFeature,
  PLAN_FEATURES,
  PLAN_LIMITS,
  type FeatureKey,
  type PlanCode,
} from "@/lib/plans";

/**
 * Tableau comparatif Découverte / Analyse. Chaque ligne est calculée à partir des
 * droits réels de src/lib/plans.ts : la page ne peut pas promettre ce que l'offre
 * ne donne pas, ni cacher ce qu'elle donne.
 */
export type OfferCell = {
  included: boolean;
  text: string;
  /**
   * Droit fermé dans l'offre mais ouvert vente par vente par les déblocages mensuels : jamais
   * présenté comme « Non inclus ».
   */
  limited?: boolean;
};
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
  /**
   * Texte propre à un plan dont les droits sont fermés. Par défaut, une ligne dont tous les droits
   * sont ouverts par un déblocage affiche « Pour N ventes par mois » au lieu de « Non inclus ».
   */
  lockedCustom?: Partial<Record<PlanCode, string>>;
  includedText?: string;
  limitedText?: string;
};

const UNLOCKS_PER_MONTH = PLAN_LIMITS.decouverte.monthlyUnlocks;
const REFERRAL_NOT_OPEN_TEXT = "Pas encore disponible";
const UNLOCK_CELL_TEXT = `${UNLOCKS_PER_MONTH} déblocages par mois`;
/**
 * Les lignes du comparatif. Le montant plafond, son nom (« enchère plafond », « offre plafond ») et
 * les ventes qui en ont un dépendent des régimes de frais ouverts (`open`, lus côté serveur dans
 * `CEILING_FEE_REGIMES_OPEN` ; absent : tous ceux dont les règles sont définies).
 *
 * L'ordre est celui de la page : ce qui distingue les deux offres d'abord (déblocages, plafond, pièces
 * et historique, alertes, estimation, statistiques, PDF et CSV), puis le reste. Le partage entre
 * « diffère » et « inclus dans les deux » se calcule sur les cellules (`splitOfferComparisonRows`).
 */
function specs(open?: readonly FeeRegimeKey[]): RowSpec[] {
  const CEILING_TERM = ceilingTermText(open);
  const CEILING_TERM_CAPITALIZED = `${CEILING_TERM.charAt(0).toUpperCase()}${CEILING_TERM.slice(1)}`;
  const CEILING_WITH_SCOPE = ceilingTermWithScopeText(open);
  return [
    {
      id: "unlocks",
      label: `Déblocage d’une vente : ${CEILING_TERM}, pièces, historique, statistiques du tribunal`,
      hint: "Ouvre ces éléments pour la vente choisie, tant qu’elle est en ligne (24 mois au plus) ; exports et rapports restent avec Analyse",
      features: ["sales.filters"],
      custom: {
        decouverte: `${UNLOCKS_PER_MONTH} déblocages par mois`,
        analyse:
          PLAN_LIMITS.analyse.monthlyUnlocks == null
            ? "Illimités : toutes les ventes sont ouvertes"
            : undefined,
      },
    },
    {
      id: "ceiling",
      label: `${CEILING_TERM_CAPITALIZED} chiffrée`,
      // Le montant plafond n'existe que pour les ventes dont un régime de frais est ouvert (voir
      // unlockedItemsText).
      hint: `Pour toutes les ventes concernées avec Analyse : ${CEILING_WITH_SCOPE} ; pour la vente choisie avec un déblocage`,
      features: ["property.bidCeiling"],
    },
    {
      id: "scenarios",
      label: "Scénarios de frais, de travaux et de marge de sécurité",
      features: ["property.advancedBidScenarios"],
      // L'onglet Travaux reste fermé sur une vente débloquée.
      lockedCustom: { decouverte: `${UNLOCK_CELL_TEXT} (hors budget travaux détaillé)` },
    },
    {
      // The free catalogue view publishes only the number of documents; the
      // documents themselves come with the detailed analysis, or with the unlock of the sale.
      id: "documents",
      label: "Pièces du dossier (cahier des conditions, procès-verbal, diagnostics)",
      // Les pièces officielles sont ouvertes par la base (vue des ventes débloquées), pas par un droit
      // de `SALE_UNLOCK_FEATURES` : l'indicateur de substitution est l'estimation détaillée, fermée
      // pour Découverte, d'où le texte explicite.
      features: ["property.valueEstimate"],
      lockedCustom: { decouverte: UNLOCK_CELL_TEXT },
    },
    {
      id: "document-reading",
      label: "Lecture des pièces : points clés cités avec la page",
      features: ["property.documentReading"],
    },
    {
      id: "passages",
      label: "Historique de la vente : passages précédents, baisses de mise à prix, reports",
      features: ["property.saleHistory"],
    },
    {
      id: "alerts",
      label: "Alertes email et zones surveillées",
      hint: "Un email récapitulatif ; critères avancés avec Analyse",
      features: ["alerts.advanced", "alerts.watchedZones"],
      custom: {
        decouverte: `${PLAN_LIMITS.decouverte.watchedZones} alerte, email hebdomadaire`,
        analyse: `Jusqu’à ${PLAN_LIMITS.analyse.watchedZones}, email quotidien`,
      },
    },
    {
      id: "estimate",
      label: "Estimation détaillée et ventes comparables",
      hint: `La valeur de référence entre dans le calcul du plafond d’une vente débloquée ; la fourchette détaillée et les ventes comparables restent avec Analyse`,
      // Un déblocage ne renvoie ni la fourchette, ni les quartiles, ni les ventes comparables : « Non
      // inclus » est exact (voir ceilingMarketContext).
      features: ["property.valueEstimate", "property.soldComparables"],
    },
    {
      id: "statistics",
      label: "Statistiques des ventes et des tribunaux",
      hint: "Tribunaux : selon l’historique disponible",
      features: ["sales.statistics"],
      // Un déblocage n'ouvre que les statistiques du tribunal de la vente débloquée.
      lockedCustom: { decouverte: `${UNLOCK_CELL_TEXT} (tribunal de la vente)` },
    },
    { id: "pdf", label: "Rapport PDF du scénario", features: ["property.pdfExport"] },
    { id: "csv", label: "Export CSV des résultats de recherche", features: ["sales.csvExport"] },
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
      id: "land",
      label: "Urbanisme, cadastre et risques du terrain",
      features: ["property.cadastralAnalysis", "property.urbanPlanning"],
    },
    {
      id: "referrals",
      label: "Mise en relation avec un avocat référencé",
      features: ["lawyers.referrals"],
    },
    {
      id: "catalogue",
      label: "Catalogue, filtres et fiches des ventes",
      features: ["sales.filters"],
    },
    {
      // « Mon dossier » : le stockage est gratuit, sur chaque vente suivie ; le calcul du montant
      // plafond garde ses droits (ligne « Enchère plafond chiffrée »).
      id: "dossier",
      label: `Statut et ${CEILING_TERM} enregistrés`,
      hint: `Sur chaque vente suivie, dans « Mon dossier » ; le calcul du plafond reste soumis à ses droits`,
      features: ["sales.favorites"],
    },
    { id: "directory", label: "Annuaire des avocats par barreau", features: ["lawyers.directory"] },
    {
      id: "listing-facts",
      label: "Adresse, photos, description, occupation et visites",
      features: ["sales.filters"],
    },
    {
      id: "value-range",
      label: "Fourchette de valeur et écart avec la mise à prix",
      features: ["sales.filters"],
    },
  ];
}

function cell(plan: PlanCode, spec: RowSpec): OfferCell {
  const levels = (spec.features ?? []).map((feature) => PLAN_FEATURES[plan][feature]);
  const included = levels.length > 0 && levels.every((level) => level !== "locked");
  const custom = spec.custom?.[plan];
  if (custom && included) return { included: true, text: custom };
  if (!included) {
    // Fermé dans l'offre, ouvert par un déblocage : on le dit, on ne l'écrit pas « Non inclus ».
    const opensWithUnlock =
      plan === "decouverte" &&
      (spec.features ?? []).length > 0 &&
      (spec.features ?? []).every(isSaleUnlockFeature);
    const lockedText = spec.lockedCustom?.[plan] ?? (opensWithUnlock ? UNLOCK_CELL_TEXT : null);
    if (lockedText) return { included: false, limited: true, text: lockedText };
  }
  return { included, text: included ? (spec.includedText ?? "Inclus") : "Non inclus" };
}

/**
 * `analysisOpen` : l'offre Analyse se souscrit pour de bon (état lu). Tant qu'il ne l'est pas, la
 * mise en relation avec un avocat, que seule Analyse donne, n'est pas promise : le tableau ne la
 * décrit pas comme « Inclus » pour une offre que l'on ne peut pas acheter.
 */
export function offerComparisonRows(
  open?: readonly FeeRegimeKey[],
  { analysisOpen = false }: { analysisOpen?: boolean } = {},
): OfferRow[] {
  return specs(open).map((spec) => {
    const analyse = cell("analyse", spec);
    return {
      id: spec.id,
      label: spec.label,
      hint: spec.hint,
      decouverte: cell("decouverte", spec),
      analyse:
        spec.id === "referrals" && analyse.included && !analysisOpen
          ? { included: false, text: REFERRAL_NOT_OPEN_TEXT }
          : analyse,
    };
  });
}

/** La ligne est la même dans les deux offres, et incluse : rien ne les y distingue. */
function isSharedRow(row: OfferRow): boolean {
  const { decouverte, analyse } = row;
  return (
    decouverte.included &&
    analyse.included &&
    decouverte.text === analyse.text &&
    Boolean(decouverte.limited) === Boolean(analyse.limited)
  );
}

/**
 * Le comparatif en deux groupes, sans retirer aucune ligne : `differences`, les lignes où Découverte
 * et Analyse diffèrent (affichées en tête), et `shared`, celles qui sont incluses à l'identique dans
 * les deux offres (repliées sous « Inclus dans les deux offres »). Chaque groupe garde l'ordre des
 * lignes. Une ligne fermée dans les deux offres n'est jamais rangée parmi les « inclus ».
 */
export function splitOfferComparisonRows(rows: readonly OfferRow[]): {
  differences: OfferRow[];
  shared: OfferRow[];
} {
  return {
    differences: rows.filter((row) => !isSharedRow(row)),
    shared: rows.filter(isSharedRow),
  };
}

/**
 * Description de l'offre Analyse (carte de /offres, première ligne de la carte de l'accueil) : le
 * plafond n'existe que pour les ventes dont un régime de frais est ouvert (`open`, absent : tous ceux
 * dont les règles sont définies), jamais pour les ventes domaniales.
 */
export function analysisOfferDescription(open?: readonly FeeRegimeKey[]): string {
  // Une carte se lit en un coup d'œil : « au tribunal ou chez le notaire » plutôt que la liste des
  // trois régimes, qui reste détaillée dans le comparatif.
  const tribunalOnly = ceilingVenueScopeText(open) === ceilingVenueScopeText(["tribunal"]);
  const venues = tribunalOnly ? "au tribunal" : "au tribunal ou chez le notaire";
  return `Le plafond des ventes ${venues}, avant de choisir celles qui méritent une visite.`;
}
