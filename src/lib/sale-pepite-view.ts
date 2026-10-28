import { formatDate, formatPrice } from "@/lib/format";
import {
  FLOOD_EXPOSED_LONG,
  FLOOD_EXPOSED_SHORT,
  FLOOD_NONE_FOUND_DETAIL,
  FLOOD_NONE_FOUND_LINE,
  FLOOD_NO_SIGNAL_LINE,
  FLOOD_TRI_ONLY_LINE,
  FLOOD_PM1_SOURCE_URL,
  FLOOD_TRI_SOURCE_URL,
  FLOOD_UNKNOWN_LAST_CHECK_PREFIX,
  FLOOD_UNKNOWN_LINE,
  FLOOD_WARNING,
  floodPm1SourceLine,
  floodTriSourceLine,
  type PepiteFloodDisplayVerdict,
} from "@/lib/pepite-flood-copy";
import { pepiteConfirmLabel, pepitePassLabel } from "@/lib/pepite-reasons";
import {
  PEPITE_CHANCE_EXIT_SHARE,
  PEPITE_CHANCE_MIN_SHARE,
  PEPITE_COST_EXIT_SHARE_COURT,
  PEPITE_COST_MAX_SHARE_COURT,
  PEPITE_COST_EXIT_SHARE_NOTARY,
  PEPITE_COST_MAX_SHARE_NOTARY,
  PEPITE_COURT_REPLACE_BELOW_SALES,
  PEPITE_CRITERIA,
  PEPITE_BLOCKING_CRITERIA,
  PEPITE_PRICE_COURT_ONLY_FROM_SALES,
  type PepiteCriterionId,
  type PepiteRegimeKey,
} from "@/lib/pepite-policy";

/**
 * Ce que la fiche d'une vente lit du repère « Pépite » (`GET /api/sales/[id]/pepite`), composé côté serveur :
 * les textes sont écrits ici, une fois, et le navigateur ne fait que les afficher (le budget de JavaScript de la
 * fiche ne porte ni les libellés des critères ni les phrases de la condition).
 *
 * Deux niveaux, jamais mélangés :
 *  - « criteria » (visiteur, compte Découverte qui n'a pas débloqué la vente) : le NOM des critères réunis,
 *    sans valeur ni montant, et le contrôle du risque d'inondation (`flood` : un fait public sans montant) ;
 *  - « detail » (offre Analyse, vente débloquée) : en plus, la condition, le plafond de référence, le prix
 *    probable et sa fourchette, avec leurs réserves.
 * `pepiteCriteriaPayload` ne reçoit jamais le détail privé : un montant ne peut pas partir par ce niveau.
 */
export type PepiteCriterionView = {
  /** Code du critère, pour la clé de liste. */
  id: PepiteCriterionId;
  label: string;
  /** « pass » : réussi ; « confirm » : sous le seuil d'entrée mais au-dessus du seuil de sortie (à confirmer). */
  state: "pass" | "confirm";
};

/** Les deux tests de la règle, présentés en tête ; tout le reste est une vérification de fiabilité. */
export const PEPITE_TEST_IDS: readonly PepiteCriterionId[] = ["test_b_chance", "test_c_cost"];

/**
 * Le contrôle du risque d'inondation tel que la fiche l'affiche (règle `pepite-v2`, textes dans
 * `pepite-flood-copy.ts`). Un fait public, sans montant : il part au niveau « criteria ». Jamais de coche pour
 * « exposé », « aucun signal » ou « inconnu » (`tone`).
 */
export type PepiteFloodView = {
  verdict: PepiteFloodDisplayVerdict;
  /** « check » : coche (rien d'élevé identifié) ; « alert » : pictogramme d'alerte (exposé) ; « neutral » : ligne neutre. */
  tone: "check" | "alert" | "neutral";
  /** La phrase de la ligne d'inondation. */
  line: string;
  /** Texte développé : cartes consultées (replié) ou mention longue « exposé » ; `null` : aucun. */
  details: string | null;
  /** Mention de source, sous la ligne, avec son lien. */
  sourceLine: string | null;
  sourceUrl: string | null;
  /** Mise en garde sous le bloc Pépite. */
  warning: string;
};

export type PepiteCriteriaPayload = {
  access: "criteria";
  /** Contrôle d'inondation (règle v2) ; `null` : pas de contrôle à afficher (règle v1, vente ancienne). */
  flood: PepiteFloodView | null;
  /** Critères remplis parmi les deux critères du repère (au tribunal : chances de l'emporter et coût d'achat ; en vente notariale : le coût). */
  count: number;
  /** Les critères présents pour ce type de vente, remplis ou à confirmer (`tests` : nom historique du champ). */
  tests: PepiteCriterionView[];
  /** Les vérifications de fiabilité (tout le reste), repliées sur la fiche. */
  checks: PepiteCriterionView[];
  /** Vérifications de fiabilité remplies. */
  checksPassed: number;
};

export type PepiteDetailView = {
  regime: PepiteRegimeKey;
  /** « enchère plafond » ou « offre plafond » (vente interactive). */
  ceilingTerm: string;
  /** La condition, en toutes lettres. */
  condition: string;
  /** Plafond de référence en euros, pour le comparer à celui de l'utilisateur. */
  referenceCeilingEur: number | null;
  /** « Enchère plafond estimée : X € (hypothèses par défaut : …) ». */
  ceilingLine: string | null;
  /** « Prix de référence : environ X € (fourchette Y – Z €) », « Mise à prix : X € » ou « Première offre possible : X € ». */
  priceLine: string | null;
  /** Mise à prix très basse : on retient le prix atteint par 3 ventes sur 4. */
  priceLowNote: string | null;
  /** La réserve qui accompagne le prix (statistique, ou prix de réserve inconnu). */
  priceNote: string | null;
  /** Date du calcul (ISO). */
  calculatedAt: string | null;
};

export type PepiteDetailPayload = Omit<PepiteCriteriaPayload, "access"> & {
  access: "detail";
  detail: PepiteDetailView;
};

export type PepitePayload = PepiteCriteriaPayload | PepiteDetailPayload;

const percent = (share: number) => Math.round(share * 100);

/** Critères qui ne s'affichent pas comme les autres : l'inondation a sa propre ligne (`PepiteFloodView`). */
const HIDDEN_CRITERIA: readonly PepiteCriterionId[] = ["flood_risk_known", "no_high_flood_risk"];

/** Un code de motif `pass:<critère>` ou `fail:<critère>` : le critère et son issue, ou `null` (code de stabilité). */
function parseReasonCode(code: string): { id: PepiteCriterionId; passed: boolean } | null {
  const separator = code.indexOf(":");
  const kind = code.slice(0, separator);
  const id = code.slice(separator + 1) as PepiteCriterionId;
  if ((kind !== "pass" && kind !== "fail") || !PEPITE_CRITERIA.includes(id)) return null;
  return { id, passed: kind === "pass" };
}

/**
 * Les critères d'une pépite publiée, dans l'ordre du catalogue : réussis, ou « à confirmer » quand un critère
 * est sous son seuil d'entrée mais au-dessus de son seuil de sortie (la vente est entrée à l'évaluation
 * précédente et le critère n'est plus aussi net). Un critère manqué qui ferait sortir la vente, ou un signal
 * bloquant, n'apparaît jamais : la base ne publie plus la vente. Les libellés sont ceux de l'investisseur
 * (`pepite-reasons.ts`), selon le régime (« offre plafond » pour une vente notariale interactive).
 */
export function pepiteCriteriaViews(
  reasonCodes: readonly string[],
  holdMissed: readonly string[] = [],
  regime: PepiteRegimeKey | null = null,
): PepiteCriterionView[] {
  const views: PepiteCriterionView[] = [];
  for (const code of reasonCodes) {
    const parsed = parseReasonCode(code);
    if (!parsed || HIDDEN_CRITERIA.includes(parsed.id)) continue;
    if (parsed.passed) {
      views.push({ id: parsed.id, label: pepitePassLabel(parsed.id, regime), state: "pass" });
    } else if (!PEPITE_BLOCKING_CRITERIA.includes(parsed.id) && !holdMissed.includes(parsed.id)) {
      views.push({ id: parsed.id, label: pepiteConfirmLabel(parsed.id, regime), state: "confirm" });
    }
  }
  return views.sort((a, b) => PEPITE_CRITERIA.indexOf(a.id) - PEPITE_CRITERIA.indexOf(b.id));
}

/** Niveau « criteria » : les noms des tests et des vérifications, sans la moindre valeur. */
export function pepiteCriteriaPayload(
  criteria: PepiteCriterionView[],
  flood: PepiteFloodView | null = null,
): PepiteCriteriaPayload {
  const tests = criteria.filter((criterion) => PEPITE_TEST_IDS.includes(criterion.id));
  const checks = criteria.filter((criterion) => !PEPITE_TEST_IDS.includes(criterion.id));
  return {
    access: "criteria",
    flood,
    count: tests.filter((criterion) => criterion.state === "pass").length,
    tests,
    checks,
    checksPassed: checks.filter((criterion) => criterion.state === "pass").length,
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const RELIABILITY_WORDS: Record<string, string> = { good: "bonne", medium: "moyenne" };

const DEFAULT_HYPOTHESES = "hypothèses par défaut : habiter, profil équilibré, sans travaux";

function isRegime(value: unknown): value is PepiteRegimeKey {
  return value === "tribunal" || value === "notary_auction" || value === "notary_online";
}

/** Le régime enregistré avec l'évaluation, ou `null`. */
export function pepiteRegimeOf(details: Record<string, unknown>): PepiteRegimeKey | null {
  return isRegime(details.regime) ? details.regime : null;
}

/**
 * D'où viennent les ventes comparables, d'après le calcul de la base (`app_private.court_auction_scenarios`, migration
 * 20261101120100) : à partir de 10 ventes du tribunal, la part est lissée avec la tendance nationale (le tribunal
 * pèse son effectif, le national 15 ventes) ; en dessous, c'est celle de toute la France. La fourchette de prix, elle,
 * repose sur les ventes du tribunal seules à partir de 20 ventes, sur celles de toute la France en dessous.
 */
function cohortOf(scenarios: Record<string, unknown>): {
  /** La part du critère : `court` (tribunal, complété par la tendance nationale) ou `national`. */
  kind: "court" | "national";
  /** Effectif de la fourchette de prix, et son origine. */
  price: { kind: "court" | "national"; sample: number };
} {
  const court = numberOrNull(scenarios.courtSample) ?? 0;
  const national = numberOrNull(scenarios.nationalSample) ?? court;
  return {
    kind: court < PEPITE_COURT_REPLACE_BELOW_SALES ? "national" : "court",
    price:
      court < PEPITE_PRICE_COURT_ONLY_FROM_SALES
        ? { kind: "national", sample: national }
        : { kind: "court", sample: court },
  };
}

const COHORT_PHRASE = {
  court: "du tribunal, complétées par la tendance nationale",
  national: "de toute la France",
} as const;

/** La fourchette de prix : « du tribunal » ou « de toute la France » selon l'effectif du tribunal. */
const PRICE_COHORT_PHRASE = { court: "du tribunal", national: "de toute la France" } as const;

/** La part du critère, arrondie vers le bas pour ne jamais annoncer plus que la mesure. */
function chancePercent(share: number, atLeast: boolean): string {
  return `${atLeast ? "au moins " : ""}${Math.floor(share * 100 + 1e-9)} %`;
}

/**
 * Le détail privé (`auction_sale_pepites.details`) mis en phrases, pour un compte qui a le droit de le lire.
 * `criteria` : les critères affichés. Un test « à confirmer » (sous son seuil d'entrée, au-dessus de son seuil
 * de maintien) est écrit avec son seuil de maintien, jamais avec le seuil d'entrée.
 */
export function pepiteDetailView(
  details: Record<string, unknown>,
  evaluatedAt: string | null,
  criteria: readonly PepiteCriterionView[] = [],
): PepiteDetailView | null {
  const regime = pepiteRegimeOf(details);
  if (!regime) return null;
  const online = regime === "notary_online";
  const ceilingTerm = online ? "offre plafond" : "enchère plafond";
  const reference = numberOrNull(details.referenceCeilingEur);
  const start = numberOrNull(details.startingPriceEur);
  const costRatio = numberOrNull(details.costRatio);
  const cost = costRatio == null ? "une part" : `${percent(costRatio)} %`;
  const confirmed = (id: PepiteCriterionId) =>
    criteria.some((criterion) => criterion.id === id && criterion.state === "confirm");
  const scenarios = (details.scenarios ?? {}) as Record<string, unknown>;
  const cohort = cohortOf(scenarios);

  const discountPct = numberOrNull(details.occupancyDiscountPct);
  // Bien loué : la valeur de comparaison est celle d'un bien libre diminuée de la décote d'un bien loué.
  const valueWord =
    discountPct != null && discountPct > 0
      ? `de la valeur estimée, diminuée de la décote d'un bien loué (${percent(discountPct / 100)} %)`
      : "de la valeur estimée";
  const chanceShare = numberOrNull(details.chanceShare);

  let condition: string;
  if (regime === "tribunal") {
    const measured =
      chanceShare == null
        ? `Sur les ventes comparables passées ${COHORT_PHRASE[cohort.kind]}, la part adjugée sous l'enchère plafond estimée n'est pas disponible.`
        : `Sur les ventes comparables passées ${COHORT_PHRASE[cohort.kind]}, ${chancePercent(chanceShare, details.chanceAtLeast === true)} ont été adjugées sous l'enchère plafond estimée.`;
    const chance = confirmed("test_b_chance")
      ? `${measured} Le critère est rempli à partir de ${percent(PEPITE_CHANCE_MIN_SHARE)} % ; la mention est maintenue jusqu'à ${percent(PEPITE_CHANCE_EXIT_SHARE)} % (à confirmer à la prochaine mise à jour).`
      : `${measured} Le critère est rempli à partir de ${percent(PEPITE_CHANCE_MIN_SHARE)} %.`;
    const costPart = confirmed("test_c_cost")
      ? `Au prix de référence, le coût total estimé représente ${cost} ${valueWord} ; le critère est rempli jusqu'à ${percent(PEPITE_COST_MAX_SHARE_COURT)} % et la mention est maintenue jusqu'à ${percent(PEPITE_COST_EXIT_SHARE_COURT)} % (à confirmer à la prochaine mise à jour).`
      : `Au prix de référence, le coût total estimé représente ${cost} ${valueWord} ; le critère est rempli jusqu'à ${percent(PEPITE_COST_MAX_SHARE_COURT)} %.`;
    condition = `${chance} ${costPart}`;
  } else {
    const threshold = confirmed("test_c_cost")
      ? `le critère est rempli jusqu'à ${percent(PEPITE_COST_MAX_SHARE_NOTARY)} % et la mention est maintenue jusqu'à ${percent(PEPITE_COST_EXIT_SHARE_NOTARY)} % (à confirmer à la prochaine mise à jour)`
      : `le critère est rempli jusqu'à ${percent(PEPITE_COST_MAX_SHARE_NOTARY)} %`;
    condition = online
      ? `À la première offre possible, le coût total estimé représente ${cost} ${valueWord} ; ${threshold}. L'offre plafond estimée couvre au moins la première offre possible.`
      : `Au prix de départ, le coût total estimé représente ${cost} ${valueWord} ; ${threshold}. L'enchère plafond estimée couvre au moins la mise à prix.`;
  }

  const ceilingLine =
    reference == null
      ? null
      : `${online ? "Offre" : "Enchère"} plafond estimée : ${formatPrice(reference)} (${DEFAULT_HYPOTHESES})`;
  let priceLine: string | null = null;
  let priceLowNote: string | null = null;
  let priceNote: string | null = null;
  if (regime === "tribunal") {
    const probable = numberOrNull(details.probablePriceEur);
    const low = numberOrNull(details.rangeLowEur);
    const high = numberOrNull(details.rangeHighEur);
    if (probable != null) {
      priceLine = `Prix de référence : environ ${formatPrice(probable)}${
        low != null && high != null
          ? ` (fourchette ${formatPrice(low)} – ${formatPrice(high)})`
          : ""
      }`;
      if (details.multiplierKey === "q75") {
        priceLowNote =
          "La mise à prix est très basse : nous retenons le prix atteint par 3 ventes sur 4.";
      }
      const reliability =
        RELIABILITY_WORDS[typeof scenarios.reliability === "string" ? scenarios.reliability : ""] ??
        "à confirmer";
      priceNote = `Repère statistique tiré de ${cohort.price.sample} ventes comparables passées ${PRICE_COHORT_PHRASE[cohort.price.kind]} (fiabilité ${reliability}). La moitié de ces ventes s'est conclue dans la fourchette indiquée, l'autre moitié en dehors. Ce n'est pas une prévision du prix final : les enchères peuvent dépasser ce montant.`;
    }
  } else {
    const label = online ? "Première offre possible" : "Mise à prix";
    priceLine = start == null ? null : `${label} : ${formatPrice(start)}`;
    priceNote = online
      ? "Prix de réserve du vendeur inconnu. Pas de prix de référence : aucun historique de prix d'adjudication pour les ventes notariales."
      : "Pas de prix de référence : aucun historique de prix d'adjudication pour les ventes notariales.";
  }

  return {
    regime,
    ceilingTerm,
    condition,
    referenceCeilingEur: reference,
    ceilingLine,
    priceLine,
    priceLowNote,
    priceNote,
    calculatedAt: evaluatedAt,
  };
}

export function pepiteDetailPayload(
  criteria: PepiteCriterionView[],
  detail: PepiteDetailView,
  flood: PepiteFloodView | null = null,
): PepiteDetailPayload {
  return { ...pepiteCriteriaPayload(criteria, flood), access: "detail", detail };
}

function dateText(value: unknown): string | null {
  return typeof value === "string" && value ? formatDate(value) : null;
}

/**
 * Le contrôle d'inondation d'une pépite publiée, d'après le verdict enregistré avec son évaluation
 * (`details.flood`, écrit par le traitement des pépites sous la règle v2). Ne lit que le verdict et deux dates :
 * aucun montant, aucune coordonnée. `null` : pas de contrôle (règle v1), verdict illisible ou « élevé » (une
 * pépite ne peut pas l'être : rien ne s'affiche).
 */
export function pepiteFloodView(details: Record<string, unknown>): PepiteFloodView | null {
  const flood = details.flood;
  if (!flood || typeof flood !== "object") return null;
  const record = flood as Record<string, unknown>;
  const checkedOn = dateText(record.observedAt);
  switch (record.verdict) {
    case "none_found":
      // Périmètres de PPRi non lus : le verdict ne repose que sur les TRI. Ligne neutre, sans coche, sans la phrase
      // sur les périmètres de PPRi.
      if (record.ppriChecked === false) {
        return {
          verdict: "tri_only",
          tone: "neutral",
          line: FLOOD_TRI_ONLY_LINE,
          details: null,
          sourceLine: floodTriSourceLine(checkedOn),
          sourceUrl: FLOOD_TRI_SOURCE_URL,
          warning: FLOOD_WARNING,
        };
      }
      return {
        verdict: "none_found",
        tone: "check",
        line: FLOOD_NONE_FOUND_LINE,
        details: FLOOD_NONE_FOUND_DETAIL,
        sourceLine: floodTriSourceLine(checkedOn),
        sourceUrl: FLOOD_TRI_SOURCE_URL,
        warning: FLOOD_WARNING,
      };
    case "exposed":
      return {
        verdict: "exposed",
        tone: "alert",
        line: FLOOD_EXPOSED_SHORT,
        details: FLOOD_EXPOSED_LONG,
        sourceLine: floodPm1SourceLine(checkedOn),
        sourceUrl: FLOOD_PM1_SOURCE_URL,
        warning: FLOOD_WARNING,
      };
    case "no_signal":
      return {
        verdict: "no_signal",
        tone: "neutral",
        line: FLOOD_NO_SIGNAL_LINE,
        details: null,
        sourceLine: null,
        sourceUrl: null,
        warning: FLOOD_WARNING,
      };
    case "unknown":
      return {
        verdict: "unknown",
        tone: "neutral",
        line: checkedOn
          ? `${FLOOD_UNKNOWN_LINE} ${FLOOD_UNKNOWN_LAST_CHECK_PREFIX} ${checkedOn}.`
          : FLOOD_UNKNOWN_LINE,
        details: null,
        sourceLine: null,
        sourceUrl: null,
        warning: FLOOD_WARNING,
      };
    default:
      return null;
  }
}
