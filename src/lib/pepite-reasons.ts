// Les motifs d'une évaluation de pépite, en clair : un libellé pour chaque critère réussi ou manqué
// (`reason_codes` stockés par le traitement planifié), pour la page d'administration et, plus tard, le bloc
// « Pourquoi » de la fiche. Module pur, sans donnée. Les seuils écrits viennent des constantes de la règle
// (`pepite-policy.ts`) : un libellé ne peut pas annoncer un seuil que le calcul n'applique pas.
import {
  PEPITE_CHANCE_EXIT_SHARE,
  PEPITE_CHANCE_MIN_SHARE,
  PEPITE_COST_EXIT_SHARE_COURT,
  PEPITE_COST_EXIT_SHARE_NOTARY,
  PEPITE_COST_MAX_SHARE_COURT,
  PEPITE_COST_MAX_SHARE_NOTARY,
  PEPITE_CRITERIA,
  PEPITE_EXTREME_START_RATIO_MAX,
  PEPITE_EXTREME_START_RATIO_MIN,
  PEPITE_FAVOURABLE_EVALUATIONS,
  PEPITE_FREEZE_DAYS,
  PEPITE_LOW_STARTING_PRICE_SHARE,
  PEPITE_MIN_VALUE_COMPARABLES,
  type PepiteCriterionId,
  type PepiteRegimeKey,
} from "@/lib/pepite-policy";

/**
 * Libellé d'administration d'un risque élevé : jamais affiché au public (la vente n'est pas une pépite). Ce texte
 * reste ici, hors du module de textes que le navigateur charge (`pepite-flood-copy.ts`).
 */
const FLOOD_HIGH_ADMIN_LABEL =
  "Exclue : bien situé dans la zone inondée par une crue fréquente (territoire à risque important d’inondation, scénario « forte probabilité »).";

const percent = (share: number) => `${Math.round(share * 100)} %`;
/** Une part (0 à 1) en dixièmes : 0,7 donne 7 (« 7 ventes sur 10 »). */
const tenths = (share: number) => Math.round(share * 10);

/**
 * `/admin/pepites` : ce que « aucun risque d'inondation élevé » veut dire pour CETTE vente, d'après le verdict
 * enregistré avec son évaluation (`details.flood`). Le libellé générique (`PEPITE_CRITERION_LABELS`) ne distingue
 * pas un contrôle complet, une position imprécise dans une commune sans TRI, ni un bien dans un périmètre de PPRi.
 */
export function floodPassAdminLabel(flood: { verdict?: unknown; ppriChecked?: unknown } | null) {
  switch (flood?.verdict) {
    case "none_found":
      return flood.ppriChecked === false
        ? "Aucun risque d’inondation élevé identifié d’après les TRI ; périmètres de PPRi non lus (pas de nouvelle pépite tant qu’ils ne le sont pas)"
        : "Aucun risque d’inondation élevé identifié : TRI et périmètres de PPRi consultés à la position du bien";
    case "exposed":
      return "Dans le périmètre d’un PPRi (zonage à vérifier), hors zone de crue fréquente des TRI : repère conservé, mention publique « zonage à vérifier »";
    case "no_signal":
      return "Position imprécise dans une commune sans TRI : aucun contrôle au niveau du bien, le critère n’a pas d’objet";
    default:
      return PEPITE_CRITERION_LABELS.no_high_flood_risk.pass;
  }
}

/** Pour chaque critère : ce qu'on écrit quand il est réussi, et quand il est manqué. */
export const PEPITE_CRITERION_LABELS: Record<PepiteCriterionId, { pass: string; fail: string }> = {
  regime_open: {
    pass: "Type de vente pris en compte",
    fail: "Type de vente non pris en compte",
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
    pass: "Enchère plafond calculée sur une estimation prudente de la valeur",
    fail: "Enchère plafond non calculable (valeur ou surface manquante)",
  },
  scenarios_reliable: {
    pass: "Assez de ventes passées comparables pour juger les chances",
    fail: "Pas assez de ventes passées comparables pour juger les chances de l'emporter",
  },
  estimate_reliability: {
    pass: "Estimation de fiabilité forte ou correcte",
    fail: "Estimation de fiabilité fragile ou inconnue",
  },
  estimate_sample: {
    pass: `Au moins ${PEPITE_MIN_VALUE_COMPARABLES} ventes comparables derrière l'estimation`,
    fail: `Moins de ${PEPITE_MIN_VALUE_COMPARABLES} ventes comparables derrière l'estimation`,
  },
  surface_known: {
    pass: "Surface enregistrée",
    fail: "Surface estimée et non enregistrée",
  },
  public_gap_gate: {
    pass: "Estimation assez précise pour être affichée",
    fail: "Estimation pas assez précise pour être affichée (échantillon, largeur de fourchette ou rayon)",
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
  fees_known: {
    pass: "Honoraires de négociation et frais de publicité lus dans l'annonce ou saisis",
    fail: "Honoraires de négociation ou frais de publicité non lus (valeur par défaut) : coût d'achat sous-estimé",
  },
  low_start_strong_estimate: {
    pass: `Mise à prix sous ${percent(PEPITE_LOW_STARTING_PRICE_SHARE)} de la valeur : estimation de fiabilité forte`,
    fail: `Mise à prix sous ${percent(PEPITE_LOW_STARTING_PRICE_SHARE)} de la valeur : une estimation de fiabilité forte est exigée`,
  },
  flood_risk_known: {
    pass: "Risque d’inondation contrôlé, ou sans objet pour la commune",
    fail: "Risque d’inondation non vérifié (position imprécise dans une commune qui compte un territoire à risque important d’inondation, source indisponible, ou périmètres de PPRi non lus)",
  },
  no_high_flood_risk: {
    pass: "Aucun risque d’inondation élevé identifié",
    fail: FLOOD_HIGH_ADMIN_LABEL,
  },
  no_valuation_conflict: {
    pass: "Aucun conflit de valorisation",
    fail: "Conflit de valorisation entre les données de la vente",
  },
  no_ai_block: {
    pass: "Aucune donnée importante contestée à la relecture automatique",
    fail: "Donnée importante (mise à prix, surface, type de bien, pièces) contestée à la relecture automatique",
  },
  no_degraded_condition: {
    pass: "Aucun mauvais état ou gros travaux signalé dans l'annonce",
    fail: "Mauvais état ou gros travaux signalés dans l'annonce ou les pièces",
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
    pass: "Aucun risque signalé laissé sans précision",
    fail: "Risque signalé laissé sans précision",
  },
  test_b_chance: {
    pass: `Chances de l'emporter : au moins ${tenths(PEPITE_CHANCE_MIN_SHARE)} ventes comparables sur 10 adjugées sous l'enchère plafond`,
    fail: `Chances de l'emporter insuffisantes : moins de ${tenths(PEPITE_CHANCE_MIN_SHARE)} ventes comparables sur 10 adjugées sous l'enchère plafond (ou plafond sous la mise à prix)`,
  },
  test_c_cost: {
    pass: `Coût d'achat estimé nettement sous la valeur : coût total, frais compris, d'au plus ${percent(PEPITE_COST_MAX_SHARE_COURT)} de la valeur estimée (${percent(PEPITE_COST_MAX_SHARE_NOTARY)} en vente notariale)`,
    fail: `Coût d'achat estimé pas assez sous la valeur : coût total, frais compris, au-dessus de ${percent(PEPITE_COST_MAX_SHARE_COURT)} de la valeur estimée (${percent(PEPITE_COST_MAX_SHARE_NOTARY)} en vente notariale)`,
  },
  ceiling_above_start: {
    pass: "Plafond de référence au moins égal à la mise à prix (vente à la bougie)",
    fail: "Plafond de référence sous la mise à prix (vente à la bougie)",
  },
};

/**
 * Le libellé d'un critère RÉUSSI pour l'investisseur, selon le régime : « offre plafond » (vente notariale
 * interactive) à la place de « enchère plafond » (`fee-regime-labels.ts`). Les autres libellés ne nomment pas le
 * plafond ou ne concernent que le tribunal et la vente à la bougie.
 */
export function pepitePassLabel(id: PepiteCriterionId, regime?: PepiteRegimeKey | null): string {
  const label = PEPITE_CRITERION_LABELS[id].pass;
  return regime === "notary_online"
    ? label.replace("Enchère plafond", "Offre plafond").replace("enchère plafond", "offre plafond")
    : label;
}

/**
 * Le libellé d'un critère « à confirmer » : sous son seuil d'entrée, au-dessus de son seuil de MAINTIEN. Il
 * énonce le seuil de maintien et n'affirme jamais le seuil d'entrée.
 */
export function pepiteConfirmLabel(id: PepiteCriterionId, regime?: PepiteRegimeKey | null): string {
  const later = "à confirmer à la prochaine mise à jour";
  if (id === "test_b_chance") {
    return `Chances de l'emporter toujours au-dessus du seuil de maintien (${percent(PEPITE_CHANCE_EXIT_SHARE)} des ventes comparables adjugées sous l'${regime === "notary_online" ? "offre" : "enchère"} plafond), ${later}`;
  }
  if (id === "test_c_cost") {
    const exit =
      regime && regime !== "tribunal"
        ? PEPITE_COST_EXIT_SHARE_NOTARY
        : PEPITE_COST_EXIT_SHARE_COURT;
    return `Coût d'achat estimé toujours sous le seuil de maintien (coût total, frais compris, d'au plus ${percent(exit)} de la valeur estimée), ${later}`;
  }
  return `Critère proche de son seuil de maintien, ${later}`;
}

/** Les motifs de stabilité (préfixe `stab:`). */
const STABILITY_LABELS: Record<string, string> = {
  entered: `Publiée : ${PEPITE_FAVOURABLE_EVALUATIONS} évaluations favorables consécutives`,
  exit: "Sortie : la vente ne tient plus aux seuils de sortie",
  exit_blocking: "Sortie immédiate : un signal bloquant est apparu",
  exit_quality: "Sortie pendant le gel : la qualité de l'estimation ne tient plus",
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
export function describePepiteReasonCodes(
  codes: readonly string[],
  flood: { verdict?: unknown; ppriChecked?: unknown } | null = null,
): PepiteReasonDescription {
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
      const label =
        kind === "pass" && id === "no_high_flood_risk" ? floodPassAdminLabel(flood) : labels[kind];
      (kind === "pass" ? result.passed : result.missed).push(label);
    }
  }
  return result;
}
