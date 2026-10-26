// Les motifs d'une évaluation de pépite, en clair : un libellé pour chaque critère réussi ou manqué
// (`reason_codes` stockés par le traitement planifié), pour la page d'administration et, plus tard, le bloc
// « Pourquoi » de la fiche. Module pur, sans donnée. Les seuils écrits viennent des constantes de la règle
// (`pepite-policy.ts`) : un libellé ne peut pas annoncer un seuil que le calcul n'applique pas.
import {
  PEPITE_CHANCE_MIN_SHARE,
  PEPITE_COST_MAX_SHARE_COURT,
  PEPITE_COST_MAX_SHARE_NOTARY,
  PEPITE_CRITERIA,
  PEPITE_EXTREME_START_RATIO_MAX,
  PEPITE_EXTREME_START_RATIO_MIN,
  PEPITE_FAVOURABLE_EVALUATIONS,
  PEPITE_FREEZE_DAYS,
  PEPITE_MIN_VALUE_COMPARABLES,
  type PepiteCriterionId,
} from "@/lib/pepite-policy";

const percent = (share: number) => `${Math.round(share * 100)} %`;

/** Pour chaque critère : ce qu'on écrit quand il est réussi, et quand il est manqué. */
export const PEPITE_CRITERION_LABELS: Record<PepiteCriterionId, { pass: string; fail: string }> = {
  regime_open: {
    pass: "Type de vente couvert (tribunal ou vente notariale dont le calcul est ouvert)",
    fail: "Type de vente non couvert : ni tribunal, ni vente notariale à la bougie ou interactive dont le calcul est ouvert",
  },
  sale_upcoming: {
    pass: "Vente à venir, datée dans le futur",
    fail: "Vente pas à venir, ou sans date",
  },
  starting_price_known: { pass: "Mise à prix connue", fail: "Mise à prix inconnue" },
  estimate_actionable: {
    pass: "Estimation de valeur exploitable",
    fail: "Estimation de valeur absente, périmée ou non exploitable",
  },
  ceiling_computed: {
    pass: "Enchère plafond de référence calculée (valeur basse P10)",
    fail: "Enchère plafond de référence non calculable (valeur ou surface manquante)",
  },
  scenarios_reliable: {
    pass: "Historique d'adjudications du tribunal de fiabilité suffisante (moyenne ou bonne)",
    fail: "Historique d'adjudications absent ou de fiabilité faible : le test B n'est pas évaluable",
  },
  estimate_reliability: {
    pass: "Estimation de fiabilité forte ou correcte",
    fail: "Estimation de fiabilité fragile ou inconnue",
  },
  estimate_sample: {
    pass: `Au moins ${PEPITE_MIN_VALUE_COMPARABLES} ventes comparables (effectif)`,
    fail: `Moins de ${PEPITE_MIN_VALUE_COMPARABLES} ventes comparables (effectif)`,
  },
  surface_known: {
    pass: "Surface enregistrée",
    fail: "Surface estimée et non enregistrée",
  },
  public_gap_gate: {
    pass: "Estimation qui passe la porte publique de la bande de marché",
    fail: "Estimation hors de la porte publique de la bande de marché (échantillon, largeur de fourchette ou rayon)",
  },
  gap_significant: {
    pass: "Mise à prix dans la plage plausible par rapport à la valeur estimée",
    fail: `Écart aberrant entre la mise à prix et la valeur estimée (mise à prix sous ${percent(PEPITE_EXTREME_START_RATIO_MIN)} ou au-dessus de ${percent(PEPITE_EXTREME_START_RATIO_MAX)} de la valeur)`,
  },
  property_type_supported: {
    pass: "Ni terrain seul ni actif mixte",
    fail: "Terrain seul ou actif mixte",
  },
  occupancy_known: {
    pass: "Occupation connue (libre, occupée ou louée)",
    fail: "Occupation inconnue ou bien squatté",
  },
  no_valuation_conflict: {
    pass: "Aucun conflit de valorisation",
    fail: "Conflit de valorisation entre les données de la vente",
  },
  no_ai_block: {
    pass: "Aucun champ critique bloqué par la relecture IA",
    fail: "Champ critique (mise à prix, surface, type de bien, pièces) bloqué par la relecture IA",
  },
  no_degraded_condition: {
    pass: "Aucun état dégradé documenté",
    fail: "État dégradé ou travaux à budgéter documentés dans l'annonce ou les pièces",
  },
  verification_not_conflict: {
    pass: "Vente sans conflit de vérification",
    fail: "Vente en conflit de vérification",
  },
  no_probable_duplicate: {
    pass: "Pas de doublon probable",
    fail: "Doublon probable d'une autre vente",
  },
  risks_qualified: {
    pass: "Risques documentés qualifiés",
    fail: "Risques documentés non qualifiés",
  },
  test_b_chance: {
    pass: `Test B : au moins ${percent(PEPITE_CHANCE_MIN_SHARE)} des ventes comparables adjugées sous l'enchère plafond`,
    fail: `Test B manqué : moins de ${percent(PEPITE_CHANCE_MIN_SHARE)} des ventes comparables adjugées sous l'enchère plafond (ou plafond sous la mise à prix)`,
  },
  test_c_cost: {
    pass: `Test C : coût total au prix probable d'au plus ${percent(PEPITE_COST_MAX_SHARE_COURT)} de la valeur (${percent(PEPITE_COST_MAX_SHARE_NOTARY)} en vente notariale)`,
    fail: `Test C manqué : coût total au prix probable au-dessus de ${percent(PEPITE_COST_MAX_SHARE_COURT)} de la valeur (${percent(PEPITE_COST_MAX_SHARE_NOTARY)} en vente notariale)`,
  },
  ceiling_above_start: {
    pass: "Plafond de référence au moins égal à la mise à prix (vente à la bougie)",
    fail: "Plafond de référence sous la mise à prix (vente à la bougie)",
  },
};

/** Les motifs de stabilité (préfixe `stab:`). */
const STABILITY_LABELS: Record<string, string> = {
  entered: `Publiée : ${PEPITE_FAVOURABLE_EVALUATIONS} évaluations favorables consécutives`,
  exit: "Sortie : la vente ne tient plus aux seuils de sortie",
  exit_blocking: "Sortie immédiate : un signal bloquant est apparu",
  frozen: `Résultat gelé : moins de ${PEPITE_FREEZE_DAYS} jours avant la vente`,
  price_changed: "Prix modifié : le gel est levé",
};

export type PepiteReasonDescription = {
  /** Critères réussis, dans l'ordre du catalogue. */
  passed: string[];
  /** Critères manqués, dans l'ordre du catalogue. */
  missed: string[];
  /** Ce que la stabilité a décidé (série d'évaluations favorables, entrée, sortie, gel). */
  stability: string[];
};

const KNOWN_CRITERIA = new Set<string>(PEPITE_CRITERIA);

function stabilityLabel(code: string): string | null {
  const streak = /^streak_(\d+)$/.exec(code);
  if (streak) {
    return `${streak[1]} évaluation${Number(streak[1]) > 1 ? "s" : ""} favorable${Number(streak[1]) > 1 ? "s" : ""} sur ${PEPITE_FAVOURABLE_EVALUATIONS}`;
  }
  return STABILITY_LABELS[code] ?? null;
}

/** Les codes de motif stockés, en clair. Un code inconnu (version plus récente de la règle) est ignoré. */
export function describePepiteReasonCodes(codes: readonly string[]): PepiteReasonDescription {
  const result: PepiteReasonDescription = { passed: [], missed: [], stability: [] };
  const order = (id: string) => PEPITE_CRITERIA.indexOf(id as PepiteCriterionId);
  const sorted = [...codes].sort((left, right) => order(left.slice(5)) - order(right.slice(5)));
  for (const code of sorted) {
    const separator = code.indexOf(":");
    const kind = code.slice(0, separator);
    const id = code.slice(separator + 1);
    if (kind === "stab") {
      const label = stabilityLabel(id);
      if (label) result.stability.push(label);
    } else if (KNOWN_CRITERIA.has(id) && (kind === "pass" || kind === "fail")) {
      const labels = PEPITE_CRITERION_LABELS[id as PepiteCriterionId];
      (kind === "pass" ? result.passed : result.missed).push(labels[kind]);
    }
  }
  return result;
}
