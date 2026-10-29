// Entrée de la règle `pepite` (v1 à v2.1) pour une vente : la même chaîne que la fiche (assainissement de la
// vente, relecture IA, conflit de valorisation, estimation stockée, `computeSaleCeiling`), avec les
// hypothèses par défaut de la fiche (habiter, équilibré, sans travaux, frais du régime de la vente,
// libération incluse si le bien est occupé) et la valeur BASSE (P10) de l'estimation. Les lectures
// (vente, estimation, relecture IA, scénarios d'adjudication) sont faites par l'appelant : ce module
// n'accède à aucune donnée. Il ne lit ni `investment_score`, ni aucune donnée d'avocat ou de
// sponsoring (invariant de `scripts/check-security-invariants.mjs`). Le signal « risques non qualifiés »
// reflète `score_status` du pipeline de score (`raw_payload->>score_status`, `withheld_unqualified_risks`) :
// c'est l'état d'une relecture documentaire, pas la valeur de `investment_score`, qui n'est jamais lue.
import type { AuctionScenariosResponse } from "@/lib/auction-scenarios";
import type { AiReviewProjectionReadModel, AiReviewRequestStatus } from "@/lib/ai-review-guard";
import { evaluateBid } from "@/lib/bid-ceiling-engine";
import type { FeeRegimeKey } from "@/lib/fee-regime-open";
import type { StructuredDpeDiagnostic } from "@/lib/dpe";
import type { FloodFacts } from "@/lib/flood-risk";
import { sanitizeAuctionSaleForDisplay } from "@/lib/listing-data-cleanup";
import { marketDiscountPct } from "@/lib/market-gap";
import { passesPublicMarketGapGate } from "@/lib/market-gap-band";
import { ceilingMarketEstimate } from "@/lib/market-estimate-ceiling";
import type { MarketContext } from "@/lib/market-server/types";
import {
  badgeRentInputs,
  computePepiteBadges,
  type PepiteBadge,
  type PepiteRentFacts,
} from "@/lib/pepite-badges";
import {
  coproDistressKinds,
  type CoproDistressKind,
  type CoproReadingPoint,
} from "@/lib/pepite-copro";
import { selectPepiteDpe } from "@/lib/pepite-energy";
import { marketPropertyType } from "@/lib/pepite-market";
import {
  evaluatePepite,
  pepiteRuleCapabilities,
  readsPepiteV12Data,
  type PepiteEvaluation,
  type PepiteInput,
  type PepiteMarketAggregate,
  type PepiteMarketPropertyType,
  type PepiteRegimeKey,
  type PepiteRuleVersion,
  type PepiteScenariosInput,
} from "@/lib/pepite-policy";
import { buildRenovationAnalysis } from "@/lib/renovation-analysis";
import { assessSaleCeilingInputs, computeSaleCeiling } from "@/lib/sale-ceiling";
import { getSaleProcedure } from "@/lib/sale-procedure";
import { getMarketValuationSurfaces } from "@/lib/surface";
import type { AuctionSale } from "@/lib/types";

/** Ce que la règle lit dans la ligne stockée de l'estimation (`auction_sale_market_estimates`). */
export type PepiteEstimateRow = {
  status: string;
  actionable: boolean;
  comparable_count: number;
  value_p10_eur: number | null;
  value_p50_eur: number | null;
  value_p90_eur: number | null;
  segment: string | null;
  engine_kind: string | null;
  /** Version du modèle de valeur de l'estimation (archivée avec l'évaluation, n° 25). */
  model_version?: string | null;
  computed_at: string | null;
};

/** États de la ligne d'estimation dont l'estimation peut servir (voir `usableStored`). */
const ESTIMATE_USABLE_STATUSES: readonly string[] = ["ready", "pending", "processing"];

/** États documentés de la rénovation qui écartent la vente : le plafond de référence est « sans travaux ». */
const DEGRADED_CONDITIONS: readonly string[] = ["heavy_works", "works_to_budget"];

const PEPITE_REGIMES: readonly FeeRegimeKey[] = ["tribunal", "notary_auction", "notary_online"];

/** Le verdict d'inondation de la vente (`floodFacts`), lu dans la table privée sans appel réseau. */
export type PepiteFloodFacts = FloodFacts;

export type PepiteSaleFacts = {
  /** Source de chaque poste de frais du coût d'achat (`defaut` : montant non lu). */
  fees: NonNullable<PepiteInput["fees"]>;
  /** Verdict d'inondation lu pour cette évaluation (règles v2 et v2.1 seulement) ; `null` sinon. */
  flood: PepiteFloodFacts | null;
  /** Mentions de copropriété en difficulté lues dans les pièces (pepite-v1.2 et suivantes) ; vide : aucune. */
  coproDistress?: CoproDistressKind[];
  /**
   * Badges (pepite-v1.2 et suivantes) : informations stockées avec l'évaluation, calculées APRÈS elle. Ils n'entrent
   * ni dans la règle ni dans `is_pepite`.
   */
  badges?: PepiteBadge[];
  regimeKey: PepiteRegimeKey | null;
  regimeVersion: string | null;
  /** Type de vente lu comme la fiche le lit (`getSaleProcedure`). */
  venueType: string;
  /** Mise à prix de la colonne de la vente : celle que la garde de lecture compare. */
  startingPriceColumnEur: number | null;
  /** `computed_at` de l'estimation utilisée ; `null` sans estimation. */
  estimateComputedAt: string | null;
  /** Version du modèle de valeur et moteur de l'estimation utilisée ; `null` sans estimation. */
  estimateModelVersion: string | null;
  estimateEngineKind: string | null;
  saleDate: string | null;
  occupancy: string;
  conditionStatus: string;
  propertyType: string | null;
  estimateReliability: string | null;
  estimateEffectiveSample: number | null;
  /** Écart entre la valeur centrale et la mise à prix, en % (convention de `market-gap.ts`). */
  gapDiscountPct: number | null;
  scenarios: {
    reliability: string | null;
    courtSample: number;
    nationalSample: number;
    band: number | null;
  } | null;
};

export type PepiteSourceData = {
  /** Ligne complète de `v_auction_sales_app` (ou équivalent : jamais nettoyée avant). */
  sale: AuctionSale;
  /** `raw_payload->>score_status` de la vente (`withheld_unqualified_risks` : risques non qualifiés). */
  scoreStatus: string | null;
  aiProjections: readonly AiReviewProjectionReadModel[] | null;
  aiReviewStatus: AiReviewRequestStatus;
  /** Régimes de frais ouverts (`openFeeRegimesFromEnv`). */
  regimes: readonly FeeRegimeKey[];
  /** Ligne de l'estimation stockée et son contexte (`marketContextFromStoredRow`, sans mise en file). */
  estimate: { row: PepiteEstimateRow; context: MarketContext } | null;
  /** Le modèle LightGBM de l'estimation est actif (ignoré pour un autre moteur). */
  modelActive: boolean;
  scenarios: AuctionScenariosResponse | null;
  /** Verdict d'inondation de la vente (jamais un appel réseau) ; ignoré sauf sous les règles v2 et v2.1. */
  flood: PepiteFloodFacts;
  /** Lectures de la règle v1.2 ; absentes : DPE inconnu, aucun agrégat de marché, aucune pièce lue. */
  v12?: PepiteV12Source;
  now: Date;
};

/**
 * Ce que la règle pepite-v1.2 et suivantes lit en plus (`pepite-context.server.ts`) : jamais un appel réseau, et
 * rien d'un avocat ni de la publicité.
 */
export type PepiteV12Source = {
  /** Diagnostics ADEME rapprochés de la vente, toutes confiances (la règle ne retient que ceux de 0,8 et plus). */
  dpeDiagnostics: readonly StructuredDpeDiagnostic[];
  /** `raw_payload.source_energy_diagnostics.dpe_class` de la vente. */
  listingDpeClass: unknown;
  /** Agrégats DVF de la commune de la vente, par type de logement ; le type absent n'a pas d'agrégat. */
  marketAggregates: Readonly<Partial<Record<PepiteMarketPropertyType, PepiteMarketAggregate>>>;
  /** Points de la lecture des pièces ; `null` : aucune lecture. */
  readingPoints: readonly CoproReadingPoint[] | null;
  /**
   * Loyer de référence de la vente (carte des loyers de l'ANIL), pour les badges seulement ; `null` : aucun. Le
   * plafond de la pépite se calcule sans lui.
   */
  rent: PepiteRentFacts | null;
};

function scenariosInput(response: AuctionScenariosResponse | null): PepiteScenariosInput {
  const set = response?.scenarios;
  if (!set || set.status !== "ok") return null;
  return {
    reliability: set.reliability,
    buckets: set.scenarios,
    q25: set.ratioQuartiles.q25,
    q50: set.ratioQuartiles.q50,
    q75: set.ratioQuartiles.q75,
    courtSample: set.courtSample,
    nationalSample: set.nationalSample,
  };
}

/** Entrée de la règle, et les faits stockés avec l'évaluation. */
export function buildPepiteInput(
  source: PepiteSourceData,
  ruleVersion: PepiteRuleVersion,
): {
  input: PepiteInput;
  facts: PepiteSaleFacts;
  /** Loyer estimé du bien et sa référence, pour les badges (jamais pour la règle). */
  badgeInputs: { monthlyRentEur: number | null; rent: PepiteRentFacts | null };
} {
  const { sale, now } = source;
  const capabilities = pepiteRuleCapabilities(ruleVersion);
  const v12 = readsPepiteV12Data(ruleVersion) ? (source.v12 ?? null) : null;
  const readable = sanitizeAuctionSaleForDisplay(sale);
  const inputs = assessSaleCeilingInputs({
    sale: readable,
    aiProjections: source.aiProjections,
    aiReviewStatus: source.aiReviewStatus,
    regimes: source.regimes,
  });
  const regimeKey =
    inputs.regime != null && PEPITE_REGIMES.includes(inputs.regime.key)
      ? (inputs.regime.key as PepiteRegimeKey)
      : null;

  // Estimation : la valeur BASSE (P10) porte le plafond de référence ; rien de la valeur centrale ni
  // du quart supérieur n'y entre. Le contexte rend `null` quand l'estimation est périmée (le bien a
  // changé depuis son calcul) ou absente.
  const stored = source.estimate?.context.estimate ?? null;
  const row = source.estimate?.row ?? null;
  const centralValue = row?.value_p50_eur ?? null;
  const lowValue = row?.value_p10_eur ?? null;
  // Comme la fiche (`marketContextFromStoredRow`) : une estimation « en cours de rafraîchissement » (pending ou
  // processing) reste lisible quand elle porte une estimation valable pour les caractéristiques du bien ;
  // un échec ou une estimation sans valeur n'est jamais utilisé.
  const usableStored =
    stored != null && row != null && ESTIMATE_USABLE_STATUSES.includes(row.status) ? stored : null;
  const ceilingEstimate =
    usableStored && lowValue != null && lowValue > 0
      ? {
          ...ceilingMarketEstimate(usableStored),
          estimatedValueEur: lowValue,
          medianPricePerM2: null,
          p75PricePerM2: null,
        }
      : null;

  const computed = computeSaleCeiling({ assessed: inputs, estimate: ceilingEstimate });
  const { hypotheses, plan } = computed;
  const startingPrice = hypotheses.startingPrice;
  const surfaces = getMarketValuationSurfaces(inputs.displaySale);

  const gate =
    usableStored != null &&
    row != null &&
    passesPublicMarketGapGate({
      actionable: row.actionable && usableStored.actionable === true,
      comparableCount: row.comparable_count,
      effectiveSampleSize: usableStored.effectiveSampleSize,
      intervalMethod: usableStored.predictionInterval?.method,
      p10: row.value_p10_eur,
      p50: row.value_p50_eur,
      p90: row.value_p90_eur,
      radiusM: usableStored.radiusM,
      segment: row.segment ?? usableStored.segment,
      areaKind: usableStored.areaKind,
    }) &&
    // Comme la base : un moteur LightGBM compte seulement tant que son modèle est actif.
    ((row.engine_kind ?? "comparable_ensemble") !== "hybrid_lightgbm" || source.modelActive);

  const discount = marketDiscountPct(centralValue, startingPrice);
  const renovation = buildRenovationAnalysis({
    sale: inputs.displaySale,
    surfaceM2: inputs.surface,
  });
  const procedure = getSaleProcedure(readable);
  const saleTime = sale.sale_date ? Date.parse(sale.sale_date) : Number.NaN;
  const upcoming =
    sale.status === "upcoming" && Number.isFinite(saleTime) && saleTime > now.getTime();
  const flags = Array.isArray(sale.quality_flags) ? (sale.quality_flags as unknown[]) : [];
  const propertyType = inputs.displaySale.property_type;
  const marketType = marketPropertyType(propertyType);
  const coproKinds: CoproDistressKind[] =
    capabilities.coproDistress && v12?.readingPoints ? coproDistressKinds(v12.readingPoints) : [];

  const input: PepiteInput = {
    regime: regimeKey,
    upcoming,
    startingPriceEur: startingPrice,
    estimate:
      usableStored && row
        ? {
            actionable: row.actionable && usableStored.actionable === true,
            reliability: usableStored.qualityLabel ?? null,
            effectiveSampleSize: usableStored.effectiveSampleSize ?? null,
            surfaceEstimated:
              surfaces.builtSurfaceEstimated || usableStored.subjectSurfaceEstimated === true,
            publicGatePassed: gate,
            centralValueEur: centralValue,
            lowValueEur: lowValue,
          }
        : null,
    ceiling: computed.enabled
      ? {
          available: plan.available,
          referenceEur: plan.available ? (plan.reachable ? plan.maxBid : 0) : null,
          // Coût total d'achat : le prix, les frais du régime (droits, émoluments, honoraires…) et la
          // libération du bien occupé. Ni travaux ni portage : le plafond de référence est « sans travaux ».
          totalCostAt: (price) =>
            price +
            evaluateBid(hypotheses, plan, price).fees.acquisitionFeesTotal +
            plan.releaseCost,
        }
      : null,
    scenarios: regimeKey === "tribunal" ? scenariosInput(source.scenarios) : null,
    signals: {
      landOrMixed: propertyType === "land" || propertyType === "mixed",
      occupancy: hypotheses.occupation.case,
      degradedCondition: DEGRADED_CONDITIONS.includes(renovation.status),
      valuationConflict: inputs.valuationConflict != null,
      aiBlocked: inputs.blocked.critical,
      verificationConflict:
        sale.sale_verification_status === "conflict" || procedure.verificationStatus === "conflict",
      probableDuplicate: flags.includes("probable_duplicate"),
      unqualifiedRisks: source.scoreStatus === "withheld_unqualified_risks",
      // pepite-v1.2 : une copropriété en difficulté lue dans une pièce (bloquant).
      ...(capabilities.coproDistress ? { coproDistress: coproKinds.length > 0 } : {}),
    },
    flood: { verdict: source.flood.verdict, ppriChecked: source.flood.ppriChecked },
    // pepite-v1.2 et suivantes : surface habitable (coût énergétique et plafond de taille), DPE retenu et marché
    // local. Une version antérieure ne reçoit rien de tout cela.
    ...(capabilities.energyCost || capabilities.sizeValueCap
      ? { habitableSurfaceM2: surfaces.builtSurfaceM2 }
      : {}),
    ...(capabilities.energyCost
      ? {
          energy: selectPepiteDpe({
            diagnostics: v12?.dpeDiagnostics ?? [],
            listingClass: v12?.listingDpeClass ?? null,
          }),
        }
      : {}),
    ...(capabilities.localMarket
      ? {
          market: {
            propertyType: marketType,
            aggregate: (marketType ? v12?.marketAggregates[marketType] : null) ?? null,
          },
        }
      : {}),
    // Sources des frais : `defaut` = montant non lu (refusé en vente notariale par pepite-v1.1).
    fees: {
      preliminary: regimeKey === "tribunal" ? hypotheses.feesSource.fpt : null,
      negotiation: hypotheses.feesSource.negotiation ?? null,
      advertising: hypotheses.feesSource.advertising ?? null,
    },
    // Décote d'occupation de la valeur centrale (valeur d'un bien libre) : un bien loué se négocie moins cher
    // (`rentedDiscountPct` du moteur) ; un bien occupé garde la valeur : ses frais de libération sont déjà
    // dans le coût d'achat (`releaseCost`), le moteur n'a pas d'autre décote.
    occupancyDiscountPct:
      hypotheses.occupation.case === "loue" ? hypotheses.occupation.rentedDiscountPct : 0,
  };

  const scenarioSet = source.scenarios?.scenarios;
  const facts: PepiteSaleFacts = {
    flood: capabilities.flood ? source.flood : null,
    ...(capabilities.coproDistress ? { coproDistress: coproKinds } : {}),
    fees: {
      preliminary: regimeKey === "tribunal" ? hypotheses.feesSource.fpt : null,
      negotiation: hypotheses.feesSource.negotiation ?? null,
      advertising: hypotheses.feesSource.advertising ?? null,
    },
    regimeKey,
    regimeVersion: inputs.regime?.version ?? null,
    venueType: procedure.venueType,
    // Seule une mise à prix strictement positive est stockée (la colonne refuse le reste).
    startingPriceColumnEur:
      sale.starting_price_eur != null && sale.starting_price_eur > 0
        ? sale.starting_price_eur
        : null,
    estimateComputedAt: row?.computed_at ?? null,
    estimateModelVersion: row?.model_version ?? null,
    estimateEngineKind: row?.engine_kind ?? null,
    saleDate: sale.sale_date ?? null,
    occupancy: hypotheses.occupation.case,
    conditionStatus: renovation.status,
    propertyType: sale.property_type ?? null,
    estimateReliability: usableStored?.qualityLabel ?? null,
    estimateEffectiveSample: usableStored?.effectiveSampleSize ?? null,
    gapDiscountPct: discount,
    scenarios:
      regimeKey === "tribunal" && scenarioSet
        ? {
            reliability: scenarioSet.reliability,
            courtSample: scenarioSet.courtSample,
            nationalSample: scenarioSet.nationalSample,
            band: scenarioSet.band,
          }
        : null,
  };
  // Loyer estimé pour les badges : un logement seulement, surface habitable x loyer ANIL de la vente.
  const badgeInputs = badgeRentInputs(sale, surfaces.builtSurfaceM2, v12?.rent);
  return { input, facts, badgeInputs };
}

/**
 * Évalue une vente : l'entrée, la règle, et les faits à stocker. Les badges (pepite-v1.2 et suivantes) sont calculés
 * APRÈS l'évaluation, à partir de son coût total : `evaluatePepite` ne les voit jamais, et ils ne changent ni le
 * statut ni `is_pepite`.
 */
export function evaluateSaleForPepite(
  source: PepiteSourceData,
  ruleVersion: PepiteRuleVersion,
): {
  evaluation: PepiteEvaluation;
  input: PepiteInput;
  facts: PepiteSaleFacts;
} {
  const { input, facts, badgeInputs } = buildPepiteInput(source, ruleVersion);
  const evaluation = evaluatePepite(input, ruleVersion);
  if (readsPepiteV12Data(ruleVersion)) {
    facts.badges = computePepiteBadges({
      ...badgeInputs,
      totalCostEur: evaluation.metrics.totalCostEur,
    });
  }
  return { evaluation, input, facts };
}
