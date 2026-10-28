// Filet de non-régression de la règle « pepite » : chaque verdict ci-dessous a été calculé avec la règle
// `pepite-v1` puis écrit en dur, AVANT toute évolution de la règle (compte-rendu
// `docs/equipe/2026-10-26-pepite-v2-inondation-loyers.md`, proposition n° 1).
//
// Une table figée par version de règle (v1 ci-dessous ; v2 plus bas, avec les tests de monotonie) :
//  - `V1_INPUTS` et `V1_EXPECTED` (verdicts d'évaluation), `V1_STABILITY_INPUTS` et `V1_STABILITY_EXPECTED`
//    (stabilité : entrée, maintien, gel) : ce que la règle v1 rend pour des ventes représentatives. Ces tables ne
//    changent JAMAIS : une version publiée reste rejouable telle quelle, quoi qu'il arrive à la règle courante ;
//  - une empreinte par version de règle (`FINGERPRINTS_BY_RULE_VERSION`) : elle verrouille les tables. Changer un
//    verdict figé sans ajouter une version fait échouer le test de garde. Pour changer la règle, créer une
//    nouvelle version, ajouter SA table et SON empreinte, sans toucher à celles d'une version déjà publiée.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AuctionScenario } from "@/lib/auction-scenarios";
import type { FloodVerdict } from "@/lib/flood-risk";
import {
  PEPITE_LATEST_RULE_VERSION,
  PEPITE_V1_RULE_VERSION,
  applyPepiteStability,
  evaluatePepite,
  pepiteReasonCodes,
  type PepiteEvaluation,
  type PepiteInput,
  type PepiteStability,
  type PepiteStoredState,
} from "./pepite-policy";

// Les tranches de la base (`app_private.court_auction_scenarios`) : 0-1,1 / 1,1-1,5 / 1,5-2 / 2-3 / 3+.
const BUCKETS: AuctionScenario[] = [
  { key: "near_start", lowRatio: 0, highRatio: 1.1, probability: 0.2 },
  { key: "up_to_1_5", lowRatio: 1.1, highRatio: 1.5, probability: 0.3 },
  { key: "up_to_2", lowRatio: 1.5, highRatio: 2, probability: 0.25 },
  { key: "up_to_3", lowRatio: 2, highRatio: 3, probability: 0.15 },
  { key: "above_3", lowRatio: 3, highRatio: null, probability: 0.1 },
];

/**
 * Entrée de la règle sous forme sérialisable : `totalCostAt` est une fonction, donc remplacée par un coefficient
 * (`costMultiplier` : coût total = prix × coefficient ; `null` : coût illisible).
 */
type CaseInput = Omit<PepiteInput, "ceiling" | "flood"> & {
  ceiling: {
    available: boolean;
    referenceEur: number | null;
    costMultiplier: number | null;
  } | null;
};

function toPepiteInput(input: CaseInput): PepiteInput {
  const { ceiling } = input;
  return {
    ...input,
    // La règle v1 ignore l'inondation : le pire verdict ne doit rien changer à ses résultats figés.
    flood: { verdict: "high", ppriChecked: false },
    ceiling: ceiling
      ? {
          available: ceiling.available,
          referenceEur: ceiling.referenceEur,
          totalCostAt: (price) =>
            ceiling.costMultiplier == null ? null : price * ceiling.costMultiplier,
        }
      : null,
  };
}

const SIGNALS: CaseInput["signals"] = {
  landOrMixed: false,
  occupancy: "libre",
  degradedCondition: false,
  valuationConflict: false,
  aiBlocked: false,
  verificationConflict: false,
  probableDuplicate: false,
  unqualifiedRisks: false,
};

/** Tribunal favorable : mise à prix 100 000, valeur 300 000, plafond 200 000, B à 75 %, C à 57,5 %. */
function court(overrides: Partial<CaseInput> = {}): CaseInput {
  return {
    regime: "tribunal",
    upcoming: true,
    startingPriceEur: 100_000,
    estimate: {
      actionable: true,
      reliability: "correcte",
      effectiveSampleSize: 12,
      surfaceEstimated: false,
      publicGatePassed: true,
      centralValueEur: 300_000,
      lowValueEur: 250_000,
    },
    ceiling: { available: true, referenceEur: 200_000, costMultiplier: 1.15 },
    scenarios: {
      reliability: "good",
      buckets: BUCKETS,
      q25: 1.2,
      q50: 1.5,
      q75: 2,
      courtSample: 40,
      nationalSample: 900,
    },
    signals: SIGNALS,
    ...overrides,
  };
}

/** Vente notariale favorable : mise à prix 100 000, valeur 200 000, plafond 120 000, coût 1,2 fois le prix. */
function notary(regime: "notary_auction" | "notary_online", overrides: Partial<CaseInput> = {}) {
  const base = court();
  return {
    ...base,
    regime,
    scenarios: null,
    estimate: { ...base.estimate!, centralValueEur: 200_000, lowValueEur: 180_000 },
    ceiling: { available: true, referenceEur: 120_000, costMultiplier: 1.2 },
    ...overrides,
  } satisfies CaseInput;
}

function withEstimate(
  input: CaseInput,
  changes: Partial<NonNullable<CaseInput["estimate"]>>,
): CaseInput {
  return { ...input, estimate: { ...input.estimate!, ...changes } };
}

function withSignals(input: CaseInput, changes: Partial<CaseInput["signals"]>): CaseInput {
  return { ...input, signals: { ...input.signals, ...changes } };
}

const ceilingOf = (referenceEur: number | null, costMultiplier: number | null = 1.15) => ({
  available: true,
  referenceEur,
  costMultiplier,
});

type VerdictCase = { name: string; input: CaseInput };

const V1_INPUTS: VerdictCase[] = [
  { name: "tribunal : tous les critères remplis", input: court() },
  { name: "tribunal : vente pas à venir", input: court({ upcoming: false }) },
  { name: "tribunal : aucun régime ouvert", input: court({ regime: null }) },
  { name: "tribunal : mise à prix inconnue", input: court({ startingPriceEur: null }) },
  { name: "tribunal : sans estimation", input: court({ estimate: null }) },
  {
    name: "tribunal : estimation non exploitable",
    input: withEstimate(court(), { actionable: false }),
  },
  {
    name: "tribunal : fiabilité fragile",
    input: withEstimate(court(), { reliability: "fragile" }),
  },
  { name: "tribunal : fiabilité forte", input: withEstimate(court(), { reliability: "forte" }) },
  {
    name: "tribunal : échantillon de 8 (seuil)",
    input: withEstimate(court(), { effectiveSampleSize: 8 }),
  },
  {
    name: "tribunal : échantillon de 7,9",
    input: withEstimate(court(), { effectiveSampleSize: 7.9 }),
  },
  { name: "tribunal : surface estimée", input: withEstimate(court(), { surfaceEstimated: true }) },
  {
    name: "tribunal : porte publique refusée",
    input: withEstimate(court(), { publicGatePassed: false }),
  },
  {
    name: "tribunal : mise à prix sous 10 % de la valeur",
    input: court({ startingPriceEur: 29_999 }),
  },
  {
    name: "tribunal : mise à prix à 150 % de la valeur (borne admise du garde-fou)",
    input: court({ startingPriceEur: 450_000 }),
  },
  {
    name: "tribunal : mise à prix au-dessus de 150 % de la valeur",
    input: court({ startingPriceEur: 450_001 }),
  },
  {
    name: "tribunal : mise à prix sous 30 % de la valeur (q75 retenu)",
    input: court({ startingPriceEur: 80_000 }),
  },
  { name: "tribunal : terrain ou actif mixte", input: withSignals(court(), { landOrMixed: true }) },
  { name: "tribunal : bien occupé", input: withSignals(court(), { occupancy: "occupe" }) },
  { name: "tribunal : bien loué", input: withSignals(court(), { occupancy: "loue" }) },
  { name: "tribunal : occupation inconnue", input: withSignals(court(), { occupancy: "inconnu" }) },
  { name: "tribunal : bien squatté", input: withSignals(court(), { occupancy: "squat" }) },
  {
    name: "tribunal : conflit de valorisation",
    input: withSignals(court(), { valuationConflict: true }),
  },
  { name: "tribunal : relecture IA bloquante", input: withSignals(court(), { aiBlocked: true }) },
  { name: "tribunal : état dégradé", input: withSignals(court(), { degradedCondition: true }) },
  {
    name: "tribunal : conflit de vérification",
    input: withSignals(court(), { verificationConflict: true }),
  },
  { name: "tribunal : doublon probable", input: withSignals(court(), { probableDuplicate: true }) },
  {
    name: "tribunal : risques non qualifiés",
    input: withSignals(court(), { unqualifiedRisks: true }),
  },
  {
    name: "tribunal : signal bloquant et donnée manquante",
    input: withSignals(court({ estimate: null }), { valuationConflict: true }),
  },
  { name: "tribunal : sans plafond", input: court({ ceiling: null }) },
  {
    name: "tribunal : plafond non calculable",
    input: court({ ceiling: { available: false, referenceEur: null, costMultiplier: 1.15 } }),
  },
  {
    name: "tribunal : plafond nul (aucune enchère ne tient)",
    input: court({ ceiling: ceilingOf(0) }),
  },
  { name: "tribunal : plafond sous la mise à prix", input: court({ ceiling: ceilingOf(90_000) }) },
  {
    name: "tribunal : chances de 71 % (au-dessus du seuil d'entrée du test B)",
    input: court({ ceiling: ceilingOf(192_000) }),
  },
  {
    name: "tribunal : chances de 67,5 % (entre les seuils d'entrée et de sortie du test B)",
    input: court({ ceiling: ceilingOf(185_000) }),
  },
  {
    name: "tribunal : chances de 62,5 % (sous le seuil de sortie du test B)",
    input: court({ ceiling: ceilingOf(175_000) }),
  },
  { name: "tribunal : chances de 42,5 %", input: court({ ceiling: ceilingOf(140_000) }) },
  {
    name: "tribunal : plafond très au-dessus (part plancher)",
    input: court({ ceiling: ceilingOf(450_000) }),
  },
  {
    name: "tribunal : coût à 75 % de la valeur (seuil d'entrée du test C)",
    input: court({ ceiling: ceilingOf(200_000, 1.5) }),
  },
  {
    name: "tribunal : coût entre les seuils d'entrée et de sortie du test C",
    input: court({ ceiling: ceilingOf(200_000, 1.55) }),
  },
  {
    name: "tribunal : coût au-dessus du seuil de sortie du test C",
    input: court({ ceiling: ceilingOf(200_000, 1.7) }),
  },
  { name: "tribunal : coût illisible", input: court({ ceiling: ceilingOf(200_000, null) }) },
  { name: "tribunal : sans scénarios d'adjudication", input: court({ scenarios: null }) },
  {
    name: "tribunal : scénarios peu fiables",
    input: court({ scenarios: { ...court().scenarios!, reliability: "low" } }),
  },
  {
    name: "tribunal : scénarios de fiabilité moyenne",
    input: court({ scenarios: { ...court().scenarios!, reliability: "medium" } }),
  },
  { name: "notarial à la bougie : tous les critères remplis", input: notary("notary_auction") },
  {
    name: "notarial à la bougie : plafond sous la mise à prix",
    input: notary("notary_auction", { ceiling: ceilingOf(90_000, 1.2) }),
  },
  {
    name: "notarial à la bougie : coût à 65 % de la valeur (seuil d'entrée)",
    input: notary("notary_auction", { ceiling: ceilingOf(120_000, 1.3) }),
  },
  {
    name: "notarial à la bougie : coût entre les seuils d'entrée et de sortie",
    input: notary("notary_auction", { ceiling: ceilingOf(120_000, 1.35) }),
  },
  {
    name: "notarial à la bougie : coût au-dessus du seuil de sortie",
    input: notary("notary_auction", { ceiling: ceilingOf(120_000, 1.45) }),
  },
  { name: "notarial interactif : tous les critères remplis", input: notary("notary_online") },
  {
    name: "notarial interactif : plafond sous la première offre",
    input: notary("notary_online", { ceiling: ceilingOf(90_000, 1.2) }),
  },
  {
    name: "notarial interactif : bien occupé",
    input: withSignals(notary("notary_online"), { occupancy: "occupe" }),
  },
  {
    name: "notarial interactif : relecture IA bloquante",
    input: withSignals(notary("notary_online"), { aiBlocked: true }),
  },
  {
    name: "notarial interactif : estimation fragile",
    input: withEstimate(notary("notary_online"), { reliability: "fragile" }),
  },
];

const round = (value: number | null): number | null =>
  value == null ? null : Math.round(value * 10_000) / 10_000;

/**
 * Ce que le filet fige d'une évaluation : le verdict, les critères réussis, manqués et manqués aux seuils de
 * sortie (listes écrites sur une ligne), et les deux mesures des tests.
 */
function observed(evaluation: PepiteEvaluation) {
  return {
    status: evaluation.status,
    favorable: evaluation.favorable,
    holds: evaluation.holds,
    blocking: evaluation.blocking,
    passed: evaluation.passed.join(" "),
    missed: evaluation.missed.join(" "),
    holdMissed: evaluation.holdMissed.join(" "),
    chanceShare: round(evaluation.metrics.chanceShare),
    costRatio: round(evaluation.metrics.costRatio),
  };
}

type Verdict = ReturnType<typeof observed>;

// Verdicts de la règle pepite-v1, calculés avant l'évolution et figés.
// prettier-ignore
const V1_EXPECTED: Record<string, Verdict> = {
  "tribunal : tous les critères remplis": { status: "pepite", favorable: true, holds: true, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_b_chance test_c_cost", missed: "", holdMissed: "", chanceShare: 0.75, costRatio: 0.575 },
  "tribunal : vente pas à venir": { status: "not_applicable", favorable: false, holds: false, blocking: false, passed: "regime_open", missed: "sale_upcoming", holdMissed: "sale_upcoming", chanceShare: null, costRatio: null },
  "tribunal : aucun régime ouvert": { status: "not_applicable", favorable: false, holds: false, blocking: false, passed: "sale_upcoming", missed: "regime_open", holdMissed: "regime_open", chanceShare: null, costRatio: null },
  "tribunal : mise à prix inconnue": { status: "insufficient", favorable: false, holds: false, blocking: false, passed: "regime_open sale_upcoming estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified", missed: "starting_price_known gap_significant", holdMissed: "starting_price_known gap_significant", chanceShare: null, costRatio: null },
  "tribunal : sans estimation": { status: "insufficient", favorable: false, holds: false, blocking: false, passed: "regime_open sale_upcoming starting_price_known ceiling_computed scenarios_reliable property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_b_chance", missed: "estimate_actionable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant", holdMissed: "estimate_actionable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant", chanceShare: 0.75, costRatio: null },
  "tribunal : estimation non exploitable": { status: "insufficient", favorable: false, holds: false, blocking: false, passed: "regime_open sale_upcoming starting_price_known ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_b_chance test_c_cost", missed: "estimate_actionable", holdMissed: "estimate_actionable", chanceShare: 0.75, costRatio: 0.575 },
  "tribunal : fiabilité fragile": { status: "not_pepite", favorable: false, holds: false, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_b_chance test_c_cost", missed: "estimate_reliability", holdMissed: "estimate_reliability", chanceShare: 0.75, costRatio: 0.575 },
  "tribunal : fiabilité forte": { status: "pepite", favorable: true, holds: true, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_b_chance test_c_cost", missed: "", holdMissed: "", chanceShare: 0.75, costRatio: 0.575 },
  "tribunal : échantillon de 8 (seuil)": { status: "pepite", favorable: true, holds: true, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_b_chance test_c_cost", missed: "", holdMissed: "", chanceShare: 0.75, costRatio: 0.575 },
  "tribunal : échantillon de 7,9": { status: "not_pepite", favorable: false, holds: false, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_b_chance test_c_cost", missed: "estimate_sample", holdMissed: "estimate_sample", chanceShare: 0.75, costRatio: 0.575 },
  "tribunal : surface estimée": { status: "not_pepite", favorable: false, holds: false, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_b_chance test_c_cost", missed: "surface_known", holdMissed: "surface_known", chanceShare: 0.75, costRatio: 0.575 },
  "tribunal : porte publique refusée": { status: "not_pepite", favorable: false, holds: false, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_b_chance test_c_cost", missed: "public_gap_gate", holdMissed: "public_gap_gate", chanceShare: 0.75, costRatio: 0.575 },
  "tribunal : mise à prix sous 10 % de la valeur": { status: "not_pepite", favorable: false, holds: false, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_b_chance test_c_cost", missed: "gap_significant", holdMissed: "gap_significant", chanceShare: 0.9, costRatio: 0.23 },
  "tribunal : mise à prix à 150 % de la valeur (borne admise du garde-fou)": { status: "not_pepite", favorable: false, holds: false, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified", missed: "test_b_chance test_c_cost", holdMissed: "test_b_chance test_c_cost", chanceShare: null, costRatio: 2.5875 },
  "tribunal : mise à prix au-dessus de 150 % de la valeur": { status: "not_pepite", favorable: false, holds: false, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified", missed: "gap_significant test_b_chance test_c_cost", holdMissed: "gap_significant test_b_chance test_c_cost", chanceShare: null, costRatio: 2.5875 },
  "tribunal : mise à prix sous 30 % de la valeur (q75 retenu)": { status: "pepite", favorable: true, holds: true, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_b_chance test_c_cost", missed: "", holdMissed: "", chanceShare: 0.825, costRatio: 0.6133 },
  "tribunal : terrain ou actif mixte": { status: "not_pepite", favorable: false, holds: false, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_b_chance test_c_cost", missed: "property_type_supported", holdMissed: "property_type_supported", chanceShare: 0.75, costRatio: 0.575 },
  "tribunal : bien occupé": { status: "pepite", favorable: true, holds: true, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_b_chance test_c_cost", missed: "", holdMissed: "", chanceShare: 0.75, costRatio: 0.575 },
  "tribunal : bien loué": { status: "pepite", favorable: true, holds: true, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_b_chance test_c_cost", missed: "", holdMissed: "", chanceShare: 0.75, costRatio: 0.575 },
  "tribunal : occupation inconnue": { status: "not_pepite", favorable: false, holds: false, blocking: true, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_b_chance test_c_cost", missed: "occupancy_known", holdMissed: "occupancy_known", chanceShare: 0.75, costRatio: 0.575 },
  "tribunal : bien squatté": { status: "not_pepite", favorable: false, holds: false, blocking: true, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_b_chance test_c_cost", missed: "occupancy_known", holdMissed: "occupancy_known", chanceShare: 0.75, costRatio: 0.575 },
  "tribunal : conflit de valorisation": { status: "not_pepite", favorable: false, holds: false, blocking: true, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_b_chance test_c_cost", missed: "no_valuation_conflict", holdMissed: "no_valuation_conflict", chanceShare: 0.75, costRatio: 0.575 },
  "tribunal : relecture IA bloquante": { status: "not_pepite", favorable: false, holds: false, blocking: true, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_b_chance test_c_cost", missed: "no_ai_block", holdMissed: "no_ai_block", chanceShare: 0.75, costRatio: 0.575 },
  "tribunal : état dégradé": { status: "not_pepite", favorable: false, holds: false, blocking: true, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block verification_not_conflict no_probable_duplicate risks_qualified test_b_chance test_c_cost", missed: "no_degraded_condition", holdMissed: "no_degraded_condition", chanceShare: 0.75, costRatio: 0.575 },
  "tribunal : conflit de vérification": { status: "not_pepite", favorable: false, holds: false, blocking: true, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition no_probable_duplicate risks_qualified test_b_chance test_c_cost", missed: "verification_not_conflict", holdMissed: "verification_not_conflict", chanceShare: 0.75, costRatio: 0.575 },
  "tribunal : doublon probable": { status: "not_pepite", favorable: false, holds: false, blocking: true, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict risks_qualified test_b_chance test_c_cost", missed: "no_probable_duplicate", holdMissed: "no_probable_duplicate", chanceShare: 0.75, costRatio: 0.575 },
  "tribunal : risques non qualifiés": { status: "not_pepite", favorable: false, holds: false, blocking: true, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate test_b_chance test_c_cost", missed: "risks_qualified", holdMissed: "risks_qualified", chanceShare: 0.75, costRatio: 0.575 },
  "tribunal : signal bloquant et donnée manquante": { status: "not_pepite", favorable: false, holds: false, blocking: true, passed: "regime_open sale_upcoming starting_price_known ceiling_computed scenarios_reliable property_type_supported occupancy_known no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_b_chance", missed: "estimate_actionable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant no_valuation_conflict", holdMissed: "estimate_actionable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant no_valuation_conflict", chanceShare: 0.75, costRatio: null },
  "tribunal : sans plafond": { status: "insufficient", favorable: false, holds: false, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified", missed: "ceiling_computed", holdMissed: "ceiling_computed", chanceShare: null, costRatio: null },
  "tribunal : plafond non calculable": { status: "insufficient", favorable: false, holds: false, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified", missed: "ceiling_computed", holdMissed: "ceiling_computed", chanceShare: null, costRatio: null },
  "tribunal : plafond nul (aucune enchère ne tient)": { status: "not_pepite", favorable: false, holds: false, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_c_cost", missed: "ceiling_computed test_b_chance", holdMissed: "ceiling_computed test_b_chance", chanceShare: null, costRatio: 0.575 },
  "tribunal : plafond sous la mise à prix": { status: "not_pepite", favorable: false, holds: false, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_c_cost", missed: "test_b_chance", holdMissed: "test_b_chance", chanceShare: null, costRatio: 0.575 },
  "tribunal : chances de 71 % (au-dessus du seuil d'entrée du test B)": { status: "pepite", favorable: true, holds: true, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_b_chance test_c_cost", missed: "", holdMissed: "", chanceShare: 0.71, costRatio: 0.575 },
  "tribunal : chances de 67,5 % (entre les seuils d'entrée et de sortie du test B)": { status: "not_pepite", favorable: false, holds: true, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_c_cost", missed: "test_b_chance", holdMissed: "", chanceShare: 0.675, costRatio: 0.575 },
  "tribunal : chances de 62,5 % (sous le seuil de sortie du test B)": { status: "not_pepite", favorable: false, holds: false, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_c_cost", missed: "test_b_chance", holdMissed: "test_b_chance", chanceShare: 0.625, costRatio: 0.575 },
  "tribunal : chances de 42,5 %": { status: "not_pepite", favorable: false, holds: false, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_c_cost", missed: "test_b_chance", holdMissed: "test_b_chance", chanceShare: 0.425, costRatio: 0.575 },
  "tribunal : plafond très au-dessus (part plancher)": { status: "pepite", favorable: true, holds: true, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_b_chance test_c_cost", missed: "", holdMissed: "", chanceShare: 0.9, costRatio: 0.575 },
  "tribunal : coût à 75 % de la valeur (seuil d'entrée du test C)": { status: "pepite", favorable: true, holds: true, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_b_chance test_c_cost", missed: "", holdMissed: "", chanceShare: 0.75, costRatio: 0.75 },
  "tribunal : coût entre les seuils d'entrée et de sortie du test C": { status: "not_pepite", favorable: false, holds: true, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_b_chance", missed: "test_c_cost", holdMissed: "", chanceShare: 0.75, costRatio: 0.775 },
  "tribunal : coût au-dessus du seuil de sortie du test C": { status: "not_pepite", favorable: false, holds: false, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_b_chance", missed: "test_c_cost", holdMissed: "test_c_cost", chanceShare: 0.75, costRatio: 0.85 },
  "tribunal : coût illisible": { status: "not_pepite", favorable: false, holds: false, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_b_chance", missed: "test_c_cost", holdMissed: "test_c_cost", chanceShare: 0.75, costRatio: null },
  "tribunal : sans scénarios d'adjudication": { status: "insufficient", favorable: false, holds: false, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified", missed: "scenarios_reliable", holdMissed: "scenarios_reliable", chanceShare: null, costRatio: null },
  "tribunal : scénarios peu fiables": { status: "insufficient", favorable: false, holds: false, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified", missed: "scenarios_reliable", holdMissed: "scenarios_reliable", chanceShare: null, costRatio: null },
  "tribunal : scénarios de fiabilité moyenne": { status: "pepite", favorable: true, holds: true, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_b_chance test_c_cost", missed: "", holdMissed: "", chanceShare: 0.75, costRatio: 0.575 },
  "notarial à la bougie : tous les critères remplis": { status: "pepite", favorable: true, holds: true, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_c_cost ceiling_above_start", missed: "", holdMissed: "", chanceShare: null, costRatio: 0.6 },
  "notarial à la bougie : plafond sous la mise à prix": { status: "not_pepite", favorable: false, holds: false, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_c_cost", missed: "ceiling_above_start", holdMissed: "ceiling_above_start", chanceShare: null, costRatio: 0.6 },
  "notarial à la bougie : coût à 65 % de la valeur (seuil d'entrée)": { status: "pepite", favorable: true, holds: true, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_c_cost ceiling_above_start", missed: "", holdMissed: "", chanceShare: null, costRatio: 0.65 },
  "notarial à la bougie : coût entre les seuils d'entrée et de sortie": { status: "not_pepite", favorable: false, holds: true, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified ceiling_above_start", missed: "test_c_cost", holdMissed: "", chanceShare: null, costRatio: 0.675 },
  "notarial à la bougie : coût au-dessus du seuil de sortie": { status: "not_pepite", favorable: false, holds: false, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified ceiling_above_start", missed: "test_c_cost", holdMissed: "test_c_cost", chanceShare: null, costRatio: 0.725 },
  "notarial interactif : tous les critères remplis": { status: "pepite", favorable: true, holds: true, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_c_cost", missed: "", holdMissed: "", chanceShare: null, costRatio: 0.6 },
  "notarial interactif : plafond sous la première offre": { status: "not_pepite", favorable: false, holds: false, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_c_cost", missed: "ceiling_computed", holdMissed: "ceiling_computed", chanceShare: null, costRatio: 0.6 },
  "notarial interactif : bien occupé": { status: "pepite", favorable: true, holds: true, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_c_cost", missed: "", holdMissed: "", chanceShare: null, costRatio: 0.6 },
  "notarial interactif : relecture IA bloquante": { status: "not_pepite", favorable: false, holds: false, blocking: true, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_c_cost", missed: "no_ai_block", holdMissed: "no_ai_block", chanceShare: null, costRatio: 0.6 },
  "notarial interactif : estimation fragile": { status: "not_pepite", favorable: false, holds: false, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_c_cost", missed: "estimate_reliability", holdMissed: "estimate_reliability", chanceShare: null, costRatio: 0.6 },
};

describe("filet pepite-v1 : verdicts figés", () => {
  it("rend, pour chaque vente de la table, le verdict figé", () => {
    for (const item of V1_INPUTS) {
      const evaluation = evaluatePepite(toPepiteInput(item.input), PEPITE_V1_RULE_VERSION);
      expect({ name: item.name, ...observed(evaluation) }).toEqual({
        name: item.name,
        ...V1_EXPECTED[item.name],
      });
    }
  });

  // Codes écrits à la main, ventes choisies dans la table ci-dessus : le test ne recalcule rien avec
  // `pepiteReasonCodes` (une assertion qui recopie la fonction ne pourrait jamais échouer).
  it.each([
    {
      name: "tribunal : chances de 67,5 % (entre les seuils d'entrée et de sortie du test B)",
      codes: [
        "pass:regime_open",
        "pass:sale_upcoming",
        "pass:starting_price_known",
        "pass:estimate_actionable",
        "pass:ceiling_computed",
        "pass:scenarios_reliable",
        "pass:estimate_reliability",
        "pass:estimate_sample",
        "pass:surface_known",
        "pass:public_gap_gate",
        "pass:gap_significant",
        "pass:property_type_supported",
        "pass:occupancy_known",
        "pass:no_valuation_conflict",
        "pass:no_ai_block",
        "pass:no_degraded_condition",
        "pass:verification_not_conflict",
        "pass:no_probable_duplicate",
        "pass:risks_qualified",
        "pass:test_c_cost",
        "fail:test_b_chance",
      ],
    },
    {
      name: "notarial interactif : plafond sous la première offre",
      codes: [
        "pass:regime_open",
        "pass:sale_upcoming",
        "pass:starting_price_known",
        "pass:estimate_actionable",
        "pass:estimate_reliability",
        "pass:estimate_sample",
        "pass:surface_known",
        "pass:public_gap_gate",
        "pass:gap_significant",
        "pass:property_type_supported",
        "pass:occupancy_known",
        "pass:no_valuation_conflict",
        "pass:no_ai_block",
        "pass:no_degraded_condition",
        "pass:verification_not_conflict",
        "pass:no_probable_duplicate",
        "pass:risks_qualified",
        "pass:test_c_cost",
        "fail:ceiling_computed",
      ],
    },
    {
      name: "tribunal : signal bloquant et donnée manquante",
      codes: [
        "pass:regime_open",
        "pass:sale_upcoming",
        "pass:starting_price_known",
        "pass:ceiling_computed",
        "pass:scenarios_reliable",
        "pass:property_type_supported",
        "pass:occupancy_known",
        "pass:no_ai_block",
        "pass:no_degraded_condition",
        "pass:verification_not_conflict",
        "pass:no_probable_duplicate",
        "pass:risks_qualified",
        "pass:test_b_chance",
        "fail:estimate_actionable",
        "fail:estimate_reliability",
        "fail:estimate_sample",
        "fail:surface_known",
        "fail:public_gap_gate",
        "fail:gap_significant",
        "fail:no_valuation_conflict",
      ],
    },
  ])("écrit un code de motif par critère évalué : $name", ({ name, codes }) => {
    const item = V1_INPUTS.find((entry) => entry.name === name);
    expect(item, name).toBeDefined();
    const evaluation = evaluatePepite(toPepiteInput(item!.input), PEPITE_V1_RULE_VERSION);
    expect(pepiteReasonCodes(evaluation)).toEqual(codes);
  });
});

type StabilityCase = {
  name: string;
  previous: PepiteStoredState | null;
  evaluation: Pick<PepiteEvaluation, "status" | "favorable" | "holds" | "blocking">;
  startingPriceEur: number | null;
  saleDate: string | null;
  now: string;
};

const NOW = "2026-11-10T12:00:00.000Z";
const hoursAgo = (hours: number) => new Date(Date.parse(NOW) - hours * 3_600_000).toISOString();
const daysAhead = (days: number) => new Date(Date.parse(NOW) + days * 86_400_000).toISOString();

function stored(overrides: Partial<PepiteStoredState> = {}): PepiteStoredState {
  return {
    isPepite: false,
    favorableStreak: 0,
    frozenAt: null,
    lastFavorableAt: null,
    dataMissingSince: null,
    inputStartingPriceEur: 100_000,
    ...overrides,
  };
}

const FAVORABLE = { status: "pepite", favorable: true, holds: true, blocking: false } as const;
const NOT_FAVORABLE_HOLDS = {
  status: "not_pepite",
  favorable: false,
  holds: true,
  blocking: false,
} as const;
const NOT_FAVORABLE_EXITS = {
  status: "not_pepite",
  favorable: false,
  holds: false,
  blocking: false,
} as const;
const BLOCKING = { status: "not_pepite", favorable: false, holds: false, blocking: true } as const;
const INSUFFICIENT = {
  status: "insufficient",
  favorable: false,
  holds: false,
  blocking: false,
} as const;
const NOT_APPLICABLE = {
  status: "not_applicable",
  favorable: false,
  holds: false,
  blocking: false,
} as const;

const published = (overrides: Partial<PepiteStoredState> = {}) =>
  stored({ isPepite: true, favorableStreak: 2, lastFavorableAt: hoursAgo(30), ...overrides });

const V1_STABILITY_INPUTS: StabilityCase[] = [
  {
    name: "première évaluation favorable : pas encore publiée",
    previous: null,
    evaluation: FAVORABLE,
    startingPriceEur: 100_000,
    saleDate: daysAhead(30),
    now: NOW,
  },
  {
    name: "deuxième évaluation favorable 13 h plus tard : publiée",
    previous: stored({ favorableStreak: 1, lastFavorableAt: hoursAgo(13) }),
    evaluation: FAVORABLE,
    startingPriceEur: 100_000,
    saleDate: daysAhead(30),
    now: NOW,
  },
  {
    name: "deuxième évaluation favorable 2 h plus tard : ne compte pas",
    previous: stored({ favorableStreak: 1, lastFavorableAt: hoursAgo(2) }),
    evaluation: FAVORABLE,
    startingPriceEur: 100_000,
    saleDate: daysAhead(30),
    now: NOW,
  },
  {
    name: "évaluation non favorable : la série repart de zéro",
    previous: stored({ favorableStreak: 1, lastFavorableAt: hoursAgo(13) }),
    evaluation: NOT_FAVORABLE_HOLDS,
    startingPriceEur: 100_000,
    saleDate: daysAhead(30),
    now: NOW,
  },
  {
    name: "publiée, tient aux seuils de sortie : reste publiée",
    previous: published(),
    evaluation: NOT_FAVORABLE_HOLDS,
    startingPriceEur: 100_000,
    saleDate: daysAhead(30),
    now: NOW,
  },
  {
    name: "publiée, ne tient plus aux seuils de sortie : sort",
    previous: published(),
    evaluation: NOT_FAVORABLE_EXITS,
    startingPriceEur: 100_000,
    saleDate: daysAhead(30),
    now: NOW,
  },
  {
    name: "publiée, signal bloquant : sort aussitôt",
    previous: published(),
    evaluation: BLOCKING,
    startingPriceEur: 100_000,
    saleDate: daysAhead(30),
    now: NOW,
  },
  {
    name: "publiée, gelée à J-7, signal bloquant : sort quand même",
    previous: published({ frozenAt: hoursAgo(10) }),
    evaluation: BLOCKING,
    startingPriceEur: 100_000,
    saleDate: daysAhead(5),
    now: NOW,
  },
  {
    name: "publiée, J-5, ne tient plus aux seuils de sortie : gelée, reste publiée",
    previous: published(),
    evaluation: NOT_FAVORABLE_EXITS,
    startingPriceEur: 100_000,
    saleDate: daysAhead(5),
    now: NOW,
  },
  {
    name: "publiée, J-5, prix modifié : le gel est levé et la vente sort",
    previous: published(),
    evaluation: NOT_FAVORABLE_EXITS,
    startingPriceEur: 90_000,
    saleDate: daysAhead(5),
    now: NOW,
  },
  {
    name: "non publiée, J-5 : le gel fige l'état",
    previous: stored({ favorableStreak: 1, lastFavorableAt: hoursAgo(20) }),
    evaluation: FAVORABLE,
    startingPriceEur: 100_000,
    saleDate: daysAhead(5),
    now: NOW,
  },
  {
    name: "publiée, donnée manquante depuis 2 h : tolérée",
    previous: published(),
    evaluation: INSUFFICIENT,
    startingPriceEur: 100_000,
    saleDate: daysAhead(30),
    now: NOW,
  },
  {
    name: "publiée, donnée manquante depuis 25 h : sort",
    previous: published({ dataMissingSince: hoursAgo(25) }),
    evaluation: INSUFFICIENT,
    startingPriceEur: 100_000,
    saleDate: daysAhead(30),
    now: NOW,
  },
  {
    name: "vente non applicable : remise à zéro",
    previous: published(),
    evaluation: NOT_APPLICABLE,
    startingPriceEur: 100_000,
    saleDate: daysAhead(30),
    now: NOW,
  },
];

// prettier-ignore
const V1_STABILITY_EXPECTED: Record<string, PepiteStability> = {
  "première évaluation favorable : pas encore publiée": { isPepite: false, favorableStreak: 1, frozenAt: null, lastFavorableAt: "2026-11-10T12:00:00.000Z", dataMissingSince: null, codes: ["stab:streak_1"] },
  "deuxième évaluation favorable 13 h plus tard : publiée": { isPepite: true, favorableStreak: 2, frozenAt: null, lastFavorableAt: "2026-11-10T12:00:00.000Z", dataMissingSince: null, codes: ["stab:entered"] },
  "deuxième évaluation favorable 2 h plus tard : ne compte pas": { isPepite: false, favorableStreak: 1, frozenAt: null, lastFavorableAt: "2026-11-10T10:00:00.000Z", dataMissingSince: null, codes: ["stab:streak_1"] },
  "évaluation non favorable : la série repart de zéro": { isPepite: false, favorableStreak: 0, frozenAt: null, lastFavorableAt: null, dataMissingSince: null, codes: [] },
  "publiée, tient aux seuils de sortie : reste publiée": { isPepite: true, favorableStreak: 2, frozenAt: null, lastFavorableAt: "2026-11-09T06:00:00.000Z", dataMissingSince: null, codes: [] },
  "publiée, ne tient plus aux seuils de sortie : sort": { isPepite: false, favorableStreak: 0, frozenAt: null, lastFavorableAt: null, dataMissingSince: null, codes: ["stab:exit"] },
  "publiée, signal bloquant : sort aussitôt": { isPepite: false, favorableStreak: 0, frozenAt: null, lastFavorableAt: null, dataMissingSince: null, codes: ["stab:exit_blocking"] },
  "publiée, gelée à J-7, signal bloquant : sort quand même": { isPepite: false, favorableStreak: 0, frozenAt: null, lastFavorableAt: null, dataMissingSince: null, codes: ["stab:exit_blocking"] },
  "publiée, J-5, ne tient plus aux seuils de sortie : gelée, reste publiée": { isPepite: true, favorableStreak: 2, frozenAt: "2026-11-10T12:00:00.000Z", lastFavorableAt: "2026-11-09T06:00:00.000Z", dataMissingSince: null, codes: ["stab:frozen"] },
  "publiée, J-5, prix modifié : le gel est levé et la vente sort": { isPepite: false, favorableStreak: 0, frozenAt: null, lastFavorableAt: null, dataMissingSince: null, codes: ["stab:price_changed", "stab:exit"] },
  "non publiée, J-5 : le gel fige l'état": { isPepite: false, favorableStreak: 1, frozenAt: "2026-11-10T12:00:00.000Z", lastFavorableAt: "2026-11-09T16:00:00.000Z", dataMissingSince: null, codes: ["stab:frozen"] },
  "publiée, donnée manquante depuis 2 h : tolérée": { isPepite: true, favorableStreak: 2, frozenAt: null, lastFavorableAt: "2026-11-09T06:00:00.000Z", dataMissingSince: "2026-11-10T12:00:00.000Z", codes: ["stab:data_missing"] },
  "publiée, donnée manquante depuis 25 h : sort": { isPepite: false, favorableStreak: 0, frozenAt: null, lastFavorableAt: null, dataMissingSince: null, codes: ["stab:exit_data_missing"] },
  "vente non applicable : remise à zéro": { isPepite: false, favorableStreak: 0, frozenAt: null, lastFavorableAt: null, dataMissingSince: null, codes: [] },
};

describe("filet pepite-v1 : stabilité figée", () => {
  it("rend, pour chaque état stocké de la table, la stabilité figée", () => {
    for (const item of V1_STABILITY_INPUTS) {
      const actual = applyPepiteStability({
        previous: item.previous,
        evaluation: item.evaluation as PepiteEvaluation,
        startingPriceEur: item.startingPriceEur,
        saleDate: item.saleDate,
        now: new Date(item.now),
      });
      expect({ name: item.name, ...actual }).toEqual({
        name: item.name,
        ...V1_STABILITY_EXPECTED[item.name],
      });
    }
  });
});

// Empreinte de chaque table figée, par version de règle. Elle n'est pas recalculée depuis la règle : changer un
// verdict figé sans changer la version fait échouer le test de garde.
const FINGERPRINTS_BY_RULE_VERSION: Record<string, string> = {
  "pepite-v1": "d86ff3f8992b658c",
  "pepite-v2": "1967d0b36c18d134",
};

function fingerprint(): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        verdicts: V1_INPUTS.map((item) => ({ ...item, expected: V1_EXPECTED[item.name] })),
        stability: V1_STABILITY_INPUTS.map((item) => ({
          ...item,
          expected: V1_STABILITY_EXPECTED[item.name],
        })),
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

describe("garde de version de la règle", () => {
  it("enregistre les verdicts figés sous leur version de règle", () => {
    expect(
      fingerprint(),
      `Les verdicts figés de ce fichier ne correspondent pas à l'empreinte enregistrée pour "pepite-v1". ` +
        `Si une règle change volontairement, ne modifiez pas cette table : créez une nouvelle version de ` +
        `règle, sa table et son empreinte (FINGERPRINTS_BY_RULE_VERSION).`,
    ).toBe(FINGERPRINTS_BY_RULE_VERSION["pepite-v1"]);
  });
});

// ---------------------------------------------------------------------------------------------------------
// pepite-v2 : la règle v1 + le critère éliminatoire du risque d'inondation (`flood-risk.ts`). Table figée des
// verdicts de quelques ventes représentatives, pour chaque verdict d'inondation, puis tests de monotonie : la v2
// ne rend JAMAIS favorable ce que la v1 refusait.
// ---------------------------------------------------------------------------------------------------------
const FLOOD_VERDICTS: readonly FloodVerdict[] = [
  "none_found",
  "exposed",
  "no_signal",
  "unknown",
  "high",
];

const V2_BASE_NAMES = [
  "tribunal : tous les critères remplis",
  "tribunal : chances de 67,5 % (entre les seuils d'entrée et de sortie du test B)",
  "tribunal : coût entre les seuils d'entrée et de sortie du test C",
  "tribunal : coût au-dessus du seuil de sortie du test C",
  "tribunal : sans estimation",
  "tribunal : relecture IA bloquante",
  "tribunal : vente pas à venir",
  "notarial à la bougie : tous les critères remplis",
  "notarial interactif : tous les critères remplis",
];

type V2Case = { name: string; base: string; verdict: FloodVerdict; input: CaseInput };

const inputOf = (name: string): CaseInput => {
  const found = V1_INPUTS.find((item) => item.name === name);
  if (!found) throw new Error(`Cas inconnu : ${name}`);
  return found.input;
};

const V2_INPUTS: V2Case[] = V2_BASE_NAMES.flatMap((base) =>
  FLOOD_VERDICTS.map((verdict) => ({
    name: `${base} / ${verdict}`,
    base,
    verdict,
    input: inputOf(base),
  })),
);

const evaluateV2 = (item: {
  input: CaseInput;
  verdict: FloodVerdict;
  /** Le périmètre des PPRi a été lu (vrai par défaut, comme dans la table figée). */
  ppriChecked?: boolean;
}) =>
  evaluatePepite(
    {
      ...toPepiteInput(item.input),
      flood: { verdict: item.verdict, ppriChecked: item.ppriChecked ?? true },
    },
    PEPITE_LATEST_RULE_VERSION,
  );

// Verdicts de la règle pepite-v2, calculés à sa livraison et figés.
// prettier-ignore
const V2_EXPECTED: Record<string, Verdict> = {
  "tribunal : tous les critères remplis / none_found": { status: "pepite", favorable: true, holds: true, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known flood_risk_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified no_high_flood_risk test_b_chance test_c_cost", missed: "", holdMissed: "", chanceShare: 0.75, costRatio: 0.575 },
  "tribunal : tous les critères remplis / exposed": { status: "pepite", favorable: true, holds: true, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known flood_risk_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified no_high_flood_risk test_b_chance test_c_cost", missed: "", holdMissed: "", chanceShare: 0.75, costRatio: 0.575 },
  "tribunal : tous les critères remplis / no_signal": { status: "pepite", favorable: true, holds: true, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known flood_risk_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified no_high_flood_risk test_b_chance test_c_cost", missed: "", holdMissed: "", chanceShare: 0.75, costRatio: 0.575 },
  "tribunal : tous les critères remplis / unknown": { status: "not_pepite", favorable: false, holds: true, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_b_chance test_c_cost", missed: "flood_risk_known", holdMissed: "", chanceShare: 0.75, costRatio: 0.575 },
  "tribunal : tous les critères remplis / high": { status: "not_pepite", favorable: false, holds: false, blocking: true, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known flood_risk_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_b_chance test_c_cost", missed: "no_high_flood_risk", holdMissed: "no_high_flood_risk", chanceShare: 0.75, costRatio: 0.575 },
  "tribunal : chances de 67,5 % (entre les seuils d'entrée et de sortie du test B) / none_found": { status: "not_pepite", favorable: false, holds: true, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known flood_risk_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified no_high_flood_risk test_c_cost", missed: "test_b_chance", holdMissed: "", chanceShare: 0.675, costRatio: 0.575 },
  "tribunal : chances de 67,5 % (entre les seuils d'entrée et de sortie du test B) / exposed": { status: "not_pepite", favorable: false, holds: true, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known flood_risk_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified no_high_flood_risk test_c_cost", missed: "test_b_chance", holdMissed: "", chanceShare: 0.675, costRatio: 0.575 },
  "tribunal : chances de 67,5 % (entre les seuils d'entrée et de sortie du test B) / no_signal": { status: "not_pepite", favorable: false, holds: true, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known flood_risk_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified no_high_flood_risk test_c_cost", missed: "test_b_chance", holdMissed: "", chanceShare: 0.675, costRatio: 0.575 },
  "tribunal : chances de 67,5 % (entre les seuils d'entrée et de sortie du test B) / unknown": { status: "not_pepite", favorable: false, holds: true, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_c_cost", missed: "flood_risk_known test_b_chance", holdMissed: "", chanceShare: 0.675, costRatio: 0.575 },
  "tribunal : chances de 67,5 % (entre les seuils d'entrée et de sortie du test B) / high": { status: "not_pepite", favorable: false, holds: false, blocking: true, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known flood_risk_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_c_cost", missed: "no_high_flood_risk test_b_chance", holdMissed: "no_high_flood_risk", chanceShare: 0.675, costRatio: 0.575 },
  "tribunal : coût entre les seuils d'entrée et de sortie du test C / none_found": { status: "not_pepite", favorable: false, holds: true, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known flood_risk_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified no_high_flood_risk test_b_chance", missed: "test_c_cost", holdMissed: "", chanceShare: 0.75, costRatio: 0.775 },
  "tribunal : coût entre les seuils d'entrée et de sortie du test C / exposed": { status: "not_pepite", favorable: false, holds: true, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known flood_risk_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified no_high_flood_risk test_b_chance", missed: "test_c_cost", holdMissed: "", chanceShare: 0.75, costRatio: 0.775 },
  "tribunal : coût entre les seuils d'entrée et de sortie du test C / no_signal": { status: "not_pepite", favorable: false, holds: true, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known flood_risk_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified no_high_flood_risk test_b_chance", missed: "test_c_cost", holdMissed: "", chanceShare: 0.75, costRatio: 0.775 },
  "tribunal : coût entre les seuils d'entrée et de sortie du test C / unknown": { status: "not_pepite", favorable: false, holds: true, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_b_chance", missed: "flood_risk_known test_c_cost", holdMissed: "", chanceShare: 0.75, costRatio: 0.775 },
  "tribunal : coût entre les seuils d'entrée et de sortie du test C / high": { status: "not_pepite", favorable: false, holds: false, blocking: true, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known flood_risk_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_b_chance", missed: "no_high_flood_risk test_c_cost", holdMissed: "no_high_flood_risk", chanceShare: 0.75, costRatio: 0.775 },
  "tribunal : coût au-dessus du seuil de sortie du test C / none_found": { status: "not_pepite", favorable: false, holds: false, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known flood_risk_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified no_high_flood_risk test_b_chance", missed: "test_c_cost", holdMissed: "test_c_cost", chanceShare: 0.75, costRatio: 0.85 },
  "tribunal : coût au-dessus du seuil de sortie du test C / exposed": { status: "not_pepite", favorable: false, holds: false, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known flood_risk_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified no_high_flood_risk test_b_chance", missed: "test_c_cost", holdMissed: "test_c_cost", chanceShare: 0.75, costRatio: 0.85 },
  "tribunal : coût au-dessus du seuil de sortie du test C / no_signal": { status: "not_pepite", favorable: false, holds: false, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known flood_risk_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified no_high_flood_risk test_b_chance", missed: "test_c_cost", holdMissed: "test_c_cost", chanceShare: 0.75, costRatio: 0.85 },
  "tribunal : coût au-dessus du seuil de sortie du test C / unknown": { status: "not_pepite", favorable: false, holds: false, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_b_chance", missed: "flood_risk_known test_c_cost", holdMissed: "test_c_cost", chanceShare: 0.75, costRatio: 0.85 },
  "tribunal : coût au-dessus du seuil de sortie du test C / high": { status: "not_pepite", favorable: false, holds: false, blocking: true, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known flood_risk_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_b_chance", missed: "no_high_flood_risk test_c_cost", holdMissed: "no_high_flood_risk test_c_cost", chanceShare: 0.75, costRatio: 0.85 },
  "tribunal : sans estimation / none_found": { status: "insufficient", favorable: false, holds: false, blocking: false, passed: "regime_open sale_upcoming starting_price_known ceiling_computed scenarios_reliable property_type_supported occupancy_known flood_risk_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified no_high_flood_risk test_b_chance", missed: "estimate_actionable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant", holdMissed: "estimate_actionable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant", chanceShare: 0.75, costRatio: null },
  "tribunal : sans estimation / exposed": { status: "insufficient", favorable: false, holds: false, blocking: false, passed: "regime_open sale_upcoming starting_price_known ceiling_computed scenarios_reliable property_type_supported occupancy_known flood_risk_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified no_high_flood_risk test_b_chance", missed: "estimate_actionable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant", holdMissed: "estimate_actionable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant", chanceShare: 0.75, costRatio: null },
  "tribunal : sans estimation / no_signal": { status: "insufficient", favorable: false, holds: false, blocking: false, passed: "regime_open sale_upcoming starting_price_known ceiling_computed scenarios_reliable property_type_supported occupancy_known flood_risk_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified no_high_flood_risk test_b_chance", missed: "estimate_actionable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant", holdMissed: "estimate_actionable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant", chanceShare: 0.75, costRatio: null },
  "tribunal : sans estimation / unknown": { status: "insufficient", favorable: false, holds: false, blocking: false, passed: "regime_open sale_upcoming starting_price_known ceiling_computed scenarios_reliable property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_b_chance", missed: "estimate_actionable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant flood_risk_known", holdMissed: "estimate_actionable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant", chanceShare: 0.75, costRatio: null },
  "tribunal : sans estimation / high": { status: "not_pepite", favorable: false, holds: false, blocking: true, passed: "regime_open sale_upcoming starting_price_known ceiling_computed scenarios_reliable property_type_supported occupancy_known flood_risk_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_b_chance", missed: "estimate_actionable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant no_high_flood_risk", holdMissed: "estimate_actionable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant no_high_flood_risk", chanceShare: 0.75, costRatio: null },
  "tribunal : relecture IA bloquante / none_found": { status: "not_pepite", favorable: false, holds: false, blocking: true, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known flood_risk_known no_valuation_conflict no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified no_high_flood_risk test_b_chance test_c_cost", missed: "no_ai_block", holdMissed: "no_ai_block", chanceShare: 0.75, costRatio: 0.575 },
  "tribunal : relecture IA bloquante / exposed": { status: "not_pepite", favorable: false, holds: false, blocking: true, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known flood_risk_known no_valuation_conflict no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified no_high_flood_risk test_b_chance test_c_cost", missed: "no_ai_block", holdMissed: "no_ai_block", chanceShare: 0.75, costRatio: 0.575 },
  "tribunal : relecture IA bloquante / no_signal": { status: "not_pepite", favorable: false, holds: false, blocking: true, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known flood_risk_known no_valuation_conflict no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified no_high_flood_risk test_b_chance test_c_cost", missed: "no_ai_block", holdMissed: "no_ai_block", chanceShare: 0.75, costRatio: 0.575 },
  "tribunal : relecture IA bloquante / unknown": { status: "not_pepite", favorable: false, holds: false, blocking: true, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_b_chance test_c_cost", missed: "flood_risk_known no_ai_block", holdMissed: "no_ai_block", chanceShare: 0.75, costRatio: 0.575 },
  "tribunal : relecture IA bloquante / high": { status: "not_pepite", favorable: false, holds: false, blocking: true, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed scenarios_reliable estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known flood_risk_known no_valuation_conflict no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_b_chance test_c_cost", missed: "no_ai_block no_high_flood_risk", holdMissed: "no_ai_block no_high_flood_risk", chanceShare: 0.75, costRatio: 0.575 },
  "tribunal : vente pas à venir / none_found": { status: "not_applicable", favorable: false, holds: false, blocking: false, passed: "regime_open", missed: "sale_upcoming", holdMissed: "sale_upcoming", chanceShare: null, costRatio: null },
  "tribunal : vente pas à venir / exposed": { status: "not_applicable", favorable: false, holds: false, blocking: false, passed: "regime_open", missed: "sale_upcoming", holdMissed: "sale_upcoming", chanceShare: null, costRatio: null },
  "tribunal : vente pas à venir / no_signal": { status: "not_applicable", favorable: false, holds: false, blocking: false, passed: "regime_open", missed: "sale_upcoming", holdMissed: "sale_upcoming", chanceShare: null, costRatio: null },
  "tribunal : vente pas à venir / unknown": { status: "not_applicable", favorable: false, holds: false, blocking: false, passed: "regime_open", missed: "sale_upcoming", holdMissed: "sale_upcoming", chanceShare: null, costRatio: null },
  "tribunal : vente pas à venir / high": { status: "not_applicable", favorable: false, holds: false, blocking: false, passed: "regime_open", missed: "sale_upcoming", holdMissed: "sale_upcoming", chanceShare: null, costRatio: null },
  "notarial à la bougie : tous les critères remplis / none_found": { status: "pepite", favorable: true, holds: true, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known flood_risk_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified no_high_flood_risk test_c_cost ceiling_above_start", missed: "", holdMissed: "", chanceShare: null, costRatio: 0.6 },
  "notarial à la bougie : tous les critères remplis / exposed": { status: "pepite", favorable: true, holds: true, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known flood_risk_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified no_high_flood_risk test_c_cost ceiling_above_start", missed: "", holdMissed: "", chanceShare: null, costRatio: 0.6 },
  "notarial à la bougie : tous les critères remplis / no_signal": { status: "pepite", favorable: true, holds: true, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known flood_risk_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified no_high_flood_risk test_c_cost ceiling_above_start", missed: "", holdMissed: "", chanceShare: null, costRatio: 0.6 },
  "notarial à la bougie : tous les critères remplis / unknown": { status: "not_pepite", favorable: false, holds: true, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_c_cost ceiling_above_start", missed: "flood_risk_known", holdMissed: "", chanceShare: null, costRatio: 0.6 },
  "notarial à la bougie : tous les critères remplis / high": { status: "not_pepite", favorable: false, holds: false, blocking: true, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known flood_risk_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_c_cost ceiling_above_start", missed: "no_high_flood_risk", holdMissed: "no_high_flood_risk", chanceShare: null, costRatio: 0.6 },
  "notarial interactif : tous les critères remplis / none_found": { status: "pepite", favorable: true, holds: true, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known flood_risk_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified no_high_flood_risk test_c_cost", missed: "", holdMissed: "", chanceShare: null, costRatio: 0.6 },
  "notarial interactif : tous les critères remplis / exposed": { status: "pepite", favorable: true, holds: true, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known flood_risk_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified no_high_flood_risk test_c_cost", missed: "", holdMissed: "", chanceShare: null, costRatio: 0.6 },
  "notarial interactif : tous les critères remplis / no_signal": { status: "pepite", favorable: true, holds: true, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known flood_risk_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified no_high_flood_risk test_c_cost", missed: "", holdMissed: "", chanceShare: null, costRatio: 0.6 },
  "notarial interactif : tous les critères remplis / unknown": { status: "not_pepite", favorable: false, holds: true, blocking: false, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_c_cost", missed: "flood_risk_known", holdMissed: "", chanceShare: null, costRatio: 0.6 },
  "notarial interactif : tous les critères remplis / high": { status: "not_pepite", favorable: false, holds: false, blocking: true, passed: "regime_open sale_upcoming starting_price_known estimate_actionable ceiling_computed estimate_reliability estimate_sample surface_known public_gap_gate gap_significant property_type_supported occupancy_known flood_risk_known no_valuation_conflict no_ai_block no_degraded_condition verification_not_conflict no_probable_duplicate risks_qualified test_c_cost", missed: "no_high_flood_risk", holdMissed: "no_high_flood_risk", chanceShare: null, costRatio: 0.6 },
};

describe("filet pepite-v2 : verdicts figés", () => {
  it("rend, pour chaque vente et chaque verdict d'inondation, le verdict figé", () => {
    for (const item of V2_INPUTS) {
      expect({ name: item.name, ...observed(evaluateV2(item)) }).toEqual({
        name: item.name,
        ...V2_EXPECTED[item.name],
      });
    }
  });
});

type V2StabilityCase = {
  name: string;
  previous: PepiteStoredState | null;
  base: string;
  verdict: FloodVerdict;
  startingPriceEur: number | null;
  saleDate: string | null;
  now: string;
};

const V2_STABILITY_INPUTS: V2StabilityCase[] = [
  {
    name: "inconnu : aucune nouvelle pépite (première évaluation)",
    previous: null,
    base: "tribunal : tous les critères remplis",
    verdict: "unknown",
    startingPriceEur: 100_000,
    saleDate: daysAhead(30),
    now: NOW,
  },
  {
    name: "inconnu : la série d'entrée ne progresse pas",
    previous: stored({ favorableStreak: 1, lastFavorableAt: hoursAgo(13) }),
    base: "tribunal : tous les critères remplis",
    verdict: "unknown",
    startingPriceEur: 100_000,
    saleDate: daysAhead(30),
    now: NOW,
  },
  {
    name: "aucun risque identifié : deuxième évaluation favorable, publiée",
    previous: stored({ favorableStreak: 1, lastFavorableAt: hoursAgo(13) }),
    base: "tribunal : tous les critères remplis",
    verdict: "none_found",
    startingPriceEur: 100_000,
    saleDate: daysAhead(30),
    now: NOW,
  },
  {
    name: "exposé : deuxième évaluation favorable, publiée (l'exposition n'exclut pas)",
    previous: stored({ favorableStreak: 1, lastFavorableAt: hoursAgo(13) }),
    base: "tribunal : tous les critères remplis",
    verdict: "exposed",
    startingPriceEur: 100_000,
    saleDate: daysAhead(30),
    now: NOW,
  },
  {
    name: "aucun signal : deuxième évaluation favorable, publiée",
    previous: stored({ favorableStreak: 1, lastFavorableAt: hoursAgo(13) }),
    base: "notarial interactif : tous les critères remplis",
    verdict: "no_signal",
    startingPriceEur: 100_000,
    saleDate: daysAhead(30),
    now: NOW,
  },
  {
    name: "publiée, verdict devenu inconnu : reste publiée",
    previous: published(),
    base: "tribunal : tous les critères remplis",
    verdict: "unknown",
    startingPriceEur: 100_000,
    saleDate: daysAhead(30),
    now: NOW,
  },
  {
    name: "publiée, gelée à J-5, verdict devenu inconnu : reste publiée",
    previous: published({ frozenAt: hoursAgo(10) }),
    base: "tribunal : tous les critères remplis",
    verdict: "unknown",
    startingPriceEur: 100_000,
    saleDate: daysAhead(5),
    now: NOW,
  },
  {
    name: "publiée, verdict inconnu et chances entre les seuils : reste publiée",
    previous: published(),
    base: "tribunal : chances de 67,5 % (entre les seuils d'entrée et de sortie du test B)",
    verdict: "unknown",
    startingPriceEur: 100_000,
    saleDate: daysAhead(30),
    now: NOW,
  },
  {
    name: "publiée, verdict inconnu mais coût au-dessus du seuil de sortie : sort",
    previous: published(),
    base: "tribunal : coût au-dessus du seuil de sortie du test C",
    verdict: "unknown",
    startingPriceEur: 100_000,
    saleDate: daysAhead(30),
    now: NOW,
  },
  {
    name: "publiée, risque élevé : sort aussitôt",
    previous: published(),
    base: "tribunal : tous les critères remplis",
    verdict: "high",
    startingPriceEur: 100_000,
    saleDate: daysAhead(30),
    now: NOW,
  },
  {
    name: "publiée, gelée à J-5, risque élevé : sort quand même",
    previous: published({ frozenAt: hoursAgo(10) }),
    base: "tribunal : tous les critères remplis",
    verdict: "high",
    startingPriceEur: 100_000,
    saleDate: daysAhead(5),
    now: NOW,
  },
  {
    name: "non publiée, risque élevé : jamais d'entrée",
    previous: stored({ favorableStreak: 1, lastFavorableAt: hoursAgo(13) }),
    base: "tribunal : tous les critères remplis",
    verdict: "high",
    startingPriceEur: 100_000,
    saleDate: daysAhead(30),
    now: NOW,
  },
  {
    name: "publiée en tolérance de donnée manquante, risque élevé : sort aussitôt",
    previous: published({ dataMissingSince: hoursAgo(3) }),
    base: "tribunal : sans estimation",
    verdict: "high",
    startingPriceEur: 100_000,
    saleDate: daysAhead(30),
    now: NOW,
  },
];

const stabilityOf = (item: V2StabilityCase) =>
  applyPepiteStability({
    previous: item.previous,
    evaluation: evaluateV2({ input: inputOf(item.base), verdict: item.verdict }),
    startingPriceEur: item.startingPriceEur,
    saleDate: item.saleDate,
    now: new Date(item.now),
  });

// prettier-ignore
const V2_STABILITY_EXPECTED: Record<string, PepiteStability> = {
  "inconnu : aucune nouvelle pépite (première évaluation)": { isPepite: false, favorableStreak: 0, frozenAt: null, lastFavorableAt: null, dataMissingSince: null, codes: [] },
  "inconnu : la série d'entrée ne progresse pas": { isPepite: false, favorableStreak: 0, frozenAt: null, lastFavorableAt: null, dataMissingSince: null, codes: [] },
  "aucun risque identifié : deuxième évaluation favorable, publiée": { isPepite: true, favorableStreak: 2, frozenAt: null, lastFavorableAt: "2026-11-10T12:00:00.000Z", dataMissingSince: null, codes: ["stab:entered"] },
  "exposé : deuxième évaluation favorable, publiée (l'exposition n'exclut pas)": { isPepite: true, favorableStreak: 2, frozenAt: null, lastFavorableAt: "2026-11-10T12:00:00.000Z", dataMissingSince: null, codes: ["stab:entered"] },
  "aucun signal : deuxième évaluation favorable, publiée": { isPepite: true, favorableStreak: 2, frozenAt: null, lastFavorableAt: "2026-11-10T12:00:00.000Z", dataMissingSince: null, codes: ["stab:entered"] },
  "publiée, verdict devenu inconnu : reste publiée": { isPepite: true, favorableStreak: 2, frozenAt: null, lastFavorableAt: "2026-11-09T06:00:00.000Z", dataMissingSince: null, codes: [] },
  "publiée, gelée à J-5, verdict devenu inconnu : reste publiée": { isPepite: true, favorableStreak: 2, frozenAt: "2026-11-10T02:00:00.000Z", lastFavorableAt: "2026-11-09T06:00:00.000Z", dataMissingSince: null, codes: ["stab:frozen"] },
  "publiée, verdict inconnu et chances entre les seuils : reste publiée": { isPepite: true, favorableStreak: 2, frozenAt: null, lastFavorableAt: "2026-11-09T06:00:00.000Z", dataMissingSince: null, codes: [] },
  "publiée, verdict inconnu mais coût au-dessus du seuil de sortie : sort": { isPepite: false, favorableStreak: 0, frozenAt: null, lastFavorableAt: null, dataMissingSince: null, codes: ["stab:exit"] },
  "publiée, risque élevé : sort aussitôt": { isPepite: false, favorableStreak: 0, frozenAt: null, lastFavorableAt: null, dataMissingSince: null, codes: ["stab:exit_blocking"] },
  "publiée, gelée à J-5, risque élevé : sort quand même": { isPepite: false, favorableStreak: 0, frozenAt: null, lastFavorableAt: null, dataMissingSince: null, codes: ["stab:exit_blocking"] },
  "non publiée, risque élevé : jamais d'entrée": { isPepite: false, favorableStreak: 0, frozenAt: null, lastFavorableAt: null, dataMissingSince: null, codes: [] },
  "publiée en tolérance de donnée manquante, risque élevé : sort aussitôt": { isPepite: false, favorableStreak: 0, frozenAt: null, lastFavorableAt: null, dataMissingSince: null, codes: ["stab:exit_blocking"] },
};

describe("filet pepite-v2 : stabilité figée", () => {
  it("rend, pour chaque état stocké et chaque verdict d'inondation, la stabilité figée", () => {
    for (const item of V2_STABILITY_INPUTS) {
      expect({ name: item.name, ...stabilityOf(item) }).toEqual({
        name: item.name,
        ...V2_STABILITY_EXPECTED[item.name],
      });
    }
  });
});

function fingerprintV2(): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        verdicts: V2_INPUTS.map((item) => ({ ...item, expected: V2_EXPECTED[item.name] })),
        stability: V2_STABILITY_INPUTS.map((item) => ({
          ...item,
          expected: V2_STABILITY_EXPECTED[item.name],
        })),
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

describe("garde de version de la règle courante", () => {
  it("la règle courante a sa table figée et son empreinte", () => {
    expect(Object.keys(FINGERPRINTS_BY_RULE_VERSION)).toContain(PEPITE_LATEST_RULE_VERSION);
    expect(Object.keys(FINGERPRINTS_BY_RULE_VERSION)).toContain(PEPITE_V1_RULE_VERSION);
    expect(
      fingerprintV2(),
      `Les verdicts figés de pepite-v2 ne correspondent pas à l'empreinte enregistrée. Ne modifiez pas cette ` +
        `table : créez une nouvelle version de règle, sa table et son empreinte.`,
    ).toBe(FINGERPRINTS_BY_RULE_VERSION["pepite-v2"]);
  });
});

describe("monotonie : la v2 ne rend jamais favorable ce que la v1 refusait", () => {
  const cases = V1_INPUTS.flatMap((item) =>
    FLOOD_VERDICTS.map((verdict) => ({ name: `${item.name} / ${verdict}`, item, verdict })),
  );

  it.each(cases)("$name", ({ item, verdict }) => {
    const v1 = evaluatePepite(toPepiteInput(item.input), PEPITE_V1_RULE_VERSION);
    const v2 = evaluateV2({ input: item.input, verdict });

    // Jamais plus favorable : entrée et maintien.
    expect(v2.favorable && !v1.favorable).toBe(false);
    expect(v2.holds && !v1.holds).toBe(false);
    expect(v2.status === "pepite" && v1.status !== "pepite").toBe(false);
    // Ce que la v1 jugeait bloquant, la v2 le juge bloquant ; les critères de la v1 ne changent pas.
    if (v1.blocking) expect(v2.blocking).toBe(true);
    for (const id of v1.missed) expect(v2.missed).toContain(id);
    for (const id of v1.holdMissed) expect(v2.holdMissed).toContain(id);
    // Un verdict sans conséquence (contrôlé, ou sans objet) laisse la décision de la v1 intacte.
    if (verdict === "none_found" || verdict === "exposed" || verdict === "no_signal") {
      expect({ ...observed(v2), passed: "", reasonCodes: "" }).toEqual({
        ...observed(v1),
        passed: "",
        reasonCodes: "",
      });
      expect(v2.status).toBe(v1.status);
      expect(v2.favorable).toBe(v1.favorable);
      expect(v2.holds).toBe(v1.holds);
    }
    // Un risque élevé exclut toujours : jamais d'entrée, jamais de maintien, signal bloquant.
    if (verdict === "high" && v1.status !== "not_applicable") {
      expect(v2.favorable).toBe(false);
      expect(v2.holds).toBe(false);
      expect(v2.blocking).toBe(true);
      expect(v2.missed).toContain("no_high_flood_risk");
    }
    // Inconnu : aucune nouvelle pépite, mais le maintien est celui de la v1 et ce n'est pas une donnée manquante.
    if (verdict === "unknown" && v1.status !== "not_applicable") {
      expect(v2.favorable).toBe(false);
      expect(v2.holds).toBe(v1.holds);
      expect(v2.blocking).toBe(v1.blocking);
      expect(v2.status === "insufficient").toBe(v1.status === "insufficient");
      expect(v2.missed).toContain("flood_risk_known");
      expect(v2.holdMissed).not.toContain("flood_risk_known");
      expect(v2.missed).not.toContain("no_high_flood_risk");
    }
  });

  it("le critère « aucun risque élevé » n'est évalué que si le verdict est connu", () => {
    const base = inputOf("tribunal : tous les critères remplis");
    const known = evaluateV2({ input: base, verdict: "none_found" });
    expect(known.passed).toContain("no_high_flood_risk");
    expect(known.passed).toContain("flood_risk_known");
    const unknown = evaluateV2({ input: base, verdict: "unknown" });
    expect(unknown.passed).not.toContain("no_high_flood_risk");
    expect(unknown.missed).not.toContain("no_high_flood_risk");
    expect(unknown.missed).toContain("flood_risk_known");
  });

  it("la v1 ignore le verdict d'inondation, même le pire", () => {
    for (const item of V1_INPUTS) {
      const reference = observed(evaluatePepite(toPepiteInput(item.input), PEPITE_V1_RULE_VERSION));
      for (const verdict of FLOOD_VERDICTS) {
        const input = { ...toPepiteInput(item.input), flood: { verdict, ppriChecked: false } };
        expect(observed(evaluatePepite(input, PEPITE_V1_RULE_VERSION))).toEqual(reference);
      }
    }
  });

  it("une pépite publiée dont le verdict devient inconnu reste affichée, même gelée ; seul « élevé » la fait sortir", () => {
    const base = inputOf("tribunal : tous les critères remplis");
    const previous = published({ frozenAt: hoursAgo(10) });
    const stability = (verdict: FloodVerdict) =>
      applyPepiteStability({
        previous,
        evaluation: evaluateV2({ input: base, verdict }),
        startingPriceEur: 100_000,
        saleDate: daysAhead(5),
        now: new Date(NOW),
      });
    expect(stability("unknown").isPepite).toBe(true);
    expect(stability("none_found").isPepite).toBe(true);
    expect(stability("exposed").isPepite).toBe(true);
    expect(stability("no_signal").isPepite).toBe(true);
    expect(stability("high")).toMatchObject({ isPepite: false, codes: ["stab:exit_blocking"] });
  });
});

describe("pepite-v2 : périmètre des PPRi non lu", () => {
  const base = () => inputOf("tribunal : tous les critères remplis");

  it("« aucun risque élevé » sans lecture des PPRi n'ouvre pas l'entrée et ne bloque rien", () => {
    const unread = evaluateV2({ input: base(), verdict: "none_found", ppriChecked: false });
    const read = evaluateV2({ input: base(), verdict: "none_found" });
    expect(read.favorable).toBe(true);
    expect(unread.favorable).toBe(false);
    expect(unread.blocking).toBe(false);
    expect(unread.status).toBe("not_pepite");
    expect(unread.missed).toEqual(["flood_risk_known"]);
    // Au maintien, comme un verdict inconnu : la pépite déjà publiée reste.
    expect(unread.holds).toBe(true);
    expect(unread.holdMissed).not.toContain("flood_risk_known");
    // Le critère éliminatoire est évalué : le verdict est connu.
    expect(unread.passed).toContain("no_high_flood_risk");
  });

  it("n'a pas d'effet sur les autres verdicts (exposé trouvé, risque élevé, sans objet)", () => {
    for (const verdict of ["exposed", "no_signal", "high"] as const) {
      const unread = evaluateV2({ input: base(), verdict, ppriChecked: false });
      const read = evaluateV2({ input: base(), verdict });
      expect(observed(unread)).toEqual(observed(read));
    }
  });

  it("une pépite publiée garde son repère quand le périmètre des PPRi n'a pas pu être lu", () => {
    const stability = applyPepiteStability({
      previous: published({ frozenAt: hoursAgo(10) }),
      evaluation: evaluateV2({ input: base(), verdict: "none_found", ppriChecked: false }),
      startingPriceEur: 100_000,
      saleDate: daysAhead(5),
      now: new Date(NOW),
    });
    expect(stability.isPepite).toBe(true);
  });

  it("la v1 ignore ce drapeau", () => {
    const withFlag = (ppriChecked: boolean) =>
      observed(
        evaluatePepite(
          { ...toPepiteInput(base()), flood: { verdict: "none_found", ppriChecked } },
          PEPITE_V1_RULE_VERSION,
        ),
      );
    expect(withFlag(false)).toEqual(withFlag(true));
  });
});
