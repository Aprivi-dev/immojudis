import "server-only";
import { z } from "zod";
import {
  analyzeMarketCandidates,
  resolveMarketPropertySegment,
  type MarketPropertySegment,
} from "@/lib/market-estimation-engine";
import { applyActiveHybridModel } from "@/lib/hybrid-market-valuation";
import { fetchDataGouvParkingCommune, type DataGouvParkingSale } from "@/lib/dvf-data-gouv";
import {
  getDvfMarketStatisticsFallback,
  type DvfMarketStatisticsFallback,
} from "@/lib/dvf-market-statistics";
import { recordValuationEstimate } from "@/lib/valuation-model-registry";
import { fetchCadastreSurfaceAtPoint } from "@/lib/market-cadastre";
import type {
  BuildEstimateInput,
  MarketContext,
  MarketEstimate,
  MarketEstimateErrorCode,
} from "@/lib/market-server/types";
import {
  HISTORY_YEARS,
  inputSchema,
  MIN_BUILT_SURFACE,
  URBAN_POPULATION_THRESHOLD,
} from "@/lib/market-server/constants";
import { haversineMeters } from "@/lib/market-server/geometry";
import { positiveInteger, positiveNumber, quantile, roundTo } from "@/lib/market-server/numbers";
import {
  fetchCommune,
  officialDvfCommuneCode,
  resolveMarketLocation,
} from "@/lib/market-server/sources";
import { analyzeAtRadius, recentEnough } from "@/lib/market-server/radius-analysis";

export { officialDvfCommuneCode } from "@/lib/market-server/sources";

export type {
  MarketAddressSale,
  MarketEstimate,
  MarketContext,
  MarketEstimateErrorCode,
} from "@/lib/market-server/types";

async function buildEstimate(input: BuildEstimateInput): Promise<MarketEstimate> {
  const { lat, lng } = input;
  if (isParkingProperty(input.propertyType)) return buildParkingEstimate(input);

  const resolvedSegment = resolveMarketPropertySegment({
    propertyType: input.propertyType,
    surfaceKind: input.surfaceKind,
    surfaceScope: input.surfaceScope,
  });
  if (resolvedSegment === "unsupported") {
    throw new Error("segment de bien non pris en charge par l'estimation résidentielle");
  }
  const segment = resolvedSegment;
  const subjectBuiltSurface =
    segment === "land" ? null : positiveNumber(input.surfaceM2, MIN_BUILT_SURFACE);
  let subjectLandSurface =
    positiveNumber(input.landSurfaceM2, 1) ??
    (segment === "land" && input.surfaceKind === "land"
      ? positiveNumber(input.surfaceM2, 1)
      : null);
  if (segment === "land" && !subjectLandSurface) {
    const cadastre = await fetchCadastreSurfaceAtPoint(lat, lng);
    if (cadastre) {
      subjectLandSurface = cadastre.surfaceM2;
      input.surfaceEstimated = true;
      input.surfaceAssumption = `surface cadastrale de la parcelle retenue (${Math.round(cadastre.surfaceM2)} m²), emprise exacte vendue à confirmer`;
      input.surfaceUncertaintyPct = Math.max(input.surfaceUncertaintyPct ?? 0, 35);
    }
  }
  if ((segment === "land" && !subjectLandSurface) || (segment !== "land" && !subjectBuiltSurface)) {
    throw new Error("surface compatible manquante pour le segment de bien");
  }
  const subjectSurface = segment === "land" ? subjectLandSurface : subjectBuiltSurface;
  const commune = await fetchCommune(lat, lng);
  const detailedCommune = commune
    ? { ...commune, code: officialDvfCommuneCode(commune.code, input.postalCode) }
    : null;
  const areaKind: "urban" | "rural" =
    commune && commune.population >= URBAN_POPULATION_THRESHOLD ? "urban" : "rural";

  const radii = input.radiusOverride ? [input.radiusOverride] : radiiFor(segment, areaKind);
  let analysis = await analyzeAtRadius(lat, lng, radii[0], segment, detailedCommune);
  let engineResult = analyzeMarketCandidates({
    segment,
    subjectBuiltSurfaceM2: subjectBuiltSurface,
    subjectLandSurfaceM2: subjectLandSurface,
    subjectLatitude: lat,
    subjectLongitude: lng,
    candidates: analysis.candidates,
  });
  let radiusM = radii[0];
  for (let i = 1; i < radii.length && !engineResult?.actionable; i += 1) {
    radiusM = radii[i];
    analysis = await analyzeAtRadius(lat, lng, radiusM, segment, detailedCommune);
    engineResult = analyzeMarketCandidates({
      segment,
      subjectBuiltSurfaceM2: subjectBuiltSurface,
      subjectLandSurfaceM2: subjectLandSurface,
      subjectLatitude: lat,
      subjectLongitude: lng,
      candidates: analysis.candidates,
    });
  }
  if ((!engineResult || !engineResult.actionable) && commune && subjectSurface) {
    const statisticsFallback = await getDvfMarketStatisticsFallback({
      location: {
        code: commune.code,
        name: commune.nom,
        departmentCode: commune.departmentCode,
      },
      segment,
      surfaceEstimated: input.surfaceEstimated,
      surfaceUncertaintyPct: input.surfaceUncertaintyPct,
    });
    if (statisticsFallback) {
      return buildStatisticsMarketEstimate({
        fallback: statisticsFallback,
        segment,
        subjectSurface,
        subjectLandSurface,
        subjectSurfaceEstimated: input.surfaceEstimated,
        subjectSurfaceAssumption: input.surfaceAssumption,
        subjectSurfaceUncertaintyPct: input.surfaceUncertaintyPct,
        locationSource: input.locationSource,
        locationApproximate: input.locationApproximate,
        commune: commune.nom,
        radiusM,
        yearsBack: HISTORY_YEARS,
        areaKind,
        pricePerM2Ref: input.pricePerM2Ref,
      });
    }
  }
  const radiusWidened = !input.radiusOverride && radiusM > radii[0];
  const addressHistory = analysis.addressMutations
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 5);
  const recentTransactions = (engineResult?.comparables ?? []).slice(0, 8).map((candidate) => ({
    date: candidate.date,
    pricePerM2: Math.round(candidate.pricePerM2),
    surface: Math.round(candidate.primarySurfaceM2),
    landSurface: candidate.landSurfaceM2 == null ? null : Math.round(candidate.landSurfaceM2),
    totalPrice: Math.round(candidate.totalPrice),
    type: candidate.propertyType,
    distanceM: candidate.distanceM,
    score: candidate.score,
    adjustedPricePerM2: candidate.adjustedPricePerM2,
    timeAdjustmentFactor: candidate.timeAdjustmentFactor,
    marketCell: candidate.marketCell,
  }));
  let median = engineResult?.medianPricePerM2 ?? null;
  let p10 = engineResult?.p10PricePerM2 ?? null;
  const p25 = engineResult?.p25PricePerM2 ?? null;
  const p75 = engineResult?.p75PricePerM2 ?? null;
  let p90 = engineResult?.p90PricePerM2 ?? null;
  const actionable = Boolean(
    engineResult?.actionable &&
    analysis.collectionComplete &&
    !input.surfaceEstimated &&
    !input.locationApproximate,
  );
  const quality = assessEngineQuality({
    engineResult,
    actionable,
    collectionComplete: analysis.collectionComplete,
    radiusM,
  });
  if (radiusWidened) quality.qualityWarnings.unshift(`rayon élargi à ${radiusM} m`);
  if (analysis.missingYears.length) {
    quality.qualityWarnings.unshift(
      `collecte incomplète : millésime(s) ${analysis.missingYears.join(", ")}`,
    );
  }
  if (input.surfaceEstimated) {
    quality.qualityWarnings.unshift(
      input.surfaceAssumption ?? "surface du bien estimée à partir de ses caractéristiques",
    );
  }
  if (input.locationSource === "geocoded") {
    quality.qualityWarnings.unshift(
      input.locationApproximate
        ? "localisation communale approximative déduite de l’adresse"
        : "coordonnées déduites de l’adresse publiée",
    );
  }

  let engineKind: "comparable_ensemble" | "hybrid_lightgbm" = "comparable_ensemble";
  let modelVersionId: string | null = null;
  let modelVersion: string | null = null;
  let predictionInterval: MarketEstimate["predictionInterval"] = engineResult?.predictionInterval;
  let modelDiagnostics: MarketEstimate["modelDiagnostics"] = null;
  if (engineResult && median && p10 && p90) {
    const hybrid = await applyActiveHybridModel({
      segment,
      surfaceM2: segment === "land" ? (subjectLandSurface ?? 0) : (subjectBuiltSurface ?? 0),
      landSurfaceM2: subjectLandSurface,
      roomsCount: positiveInteger(input.roomsCount),
      latitude: lat,
      longitude: lng,
      comparableMedianPricePerM2: median,
      comparableP10PricePerM2: p10,
      comparableP90PricePerM2: p90,
      comparableSampleSize: engineResult.sampleSize,
      comparableQualityScore: quality.qualityScore,
      annualMarketTrendPct: engineResult.annualMarketTrendPct,
      radiusM,
    });
    if (hybrid) {
      engineKind = "hybrid_lightgbm";
      modelVersionId = hybrid.modelVersionId;
      modelVersion = hybrid.modelVersion;
      median = hybrid.p50PricePerM2;
      p10 = hybrid.p10PricePerM2;
      p90 = hybrid.p90PricePerM2;
      predictionInterval = {
        coverageTarget: hybrid.coverageTarget,
        method: `hybrid_${hybrid.calibrationMethod}`,
        p10PricePerM2: p10,
        p50PricePerM2: median,
        p90PricePerM2: p90,
        conformalExpansionPct: Math.round((p90 / median - 1) * 1_000) / 10,
      };
      modelDiagnostics = {
        modelWeight: hybrid.modelWeight,
        rawP10PricePerM2: hybrid.rawModelPrediction.p10PricePerM2,
        rawP50PricePerM2: hybrid.rawModelPrediction.p50PricePerM2,
        rawP90PricePerM2: hybrid.rawModelPrediction.p90PricePerM2,
      };
    }
  }

  const deviationPct =
    input.pricePerM2Ref != null && input.pricePerM2Ref > 0 && median
      ? ((input.pricePerM2Ref - median) / median) * 100
      : null;
  const estimatedValueEur = median && subjectSurface ? Math.round(median * subjectSurface) : null;
  let estimatedValueLowEur = p10 && subjectSurface ? p10 * subjectSurface : null;
  let estimatedValueHighEur = p90 && subjectSurface ? p90 * subjectSurface : null;
  if (!actionable && estimatedValueEur) {
    const uncertainty = Math.max(0.28, (input.surfaceUncertaintyPct ?? 0) / 100);
    estimatedValueLowEur = Math.min(
      estimatedValueLowEur ?? Infinity,
      estimatedValueEur * (1 - uncertainty),
    );
    estimatedValueHighEur = Math.max(
      estimatedValueHighEur ?? 0,
      estimatedValueEur * (1 + uncertainty),
    );
  }

  return {
    source: analysis.source,
    engineVersion: "v3",
    engineKind,
    modelVersionId,
    modelVersion,
    segment,
    surfaceBasis: segment === "land" ? "land" : "built",
    estimationLevel: actionable ? "reliable" : "indicative",
    subjectSurfaceM2: subjectSurface,
    subjectSurfaceEstimated: input.surfaceEstimated,
    subjectSurfaceAssumption: input.surfaceAssumption,
    subjectSurfaceUncertaintyPct: input.surfaceUncertaintyPct,
    locationSource: input.locationSource,
    locationApproximate: input.locationApproximate,
    estimatedValueEur,
    estimatedValueLowEur:
      estimatedValueLowEur == null ? null : Math.round(estimatedValueLowEur / 1_000) * 1_000,
    estimatedValueHighEur:
      estimatedValueHighEur == null ? null : Math.round(estimatedValueHighEur / 1_000) * 1_000,
    actionable,
    collectionComplete: analysis.collectionComplete,
    missingYears: analysis.missingYears,
    radiusM,
    yearsBack: HISTORY_YEARS,
    areaKind,
    commune: commune?.nom ?? null,
    sampleSize: engineResult?.sampleSize ?? 0,
    effectiveSampleSize: engineResult?.effectiveSampleSize ?? 0,
    parcelSampleSize: analysis.candidates.length,
    totalNearbySampleSize: analysis.totalNearby,
    outliersRemoved: engineResult?.outliersRemoved ?? 0,
    ...quality,
    comparableMode: engineResult?.mode ?? "same_type_expanded",
    surfaceMinM2: engineResult?.primarySurfaceMinM2 ?? null,
    surfaceMaxM2: engineResult?.primarySurfaceMaxM2 ?? null,
    landSurfaceMinM2: engineResult?.landSurfaceMinM2 ?? null,
    landSurfaceMaxM2: engineResult?.landSurfaceMaxM2 ?? null,
    medianPricePerM2: median,
    p10PricePerM2: p10,
    p25PricePerM2: p25,
    p75PricePerM2: p75,
    p90PricePerM2: p90,
    minPricePerM2: engineResult?.minPricePerM2 ?? null,
    maxPricePerM2: engineResult?.maxPricePerM2 ?? null,
    deviationPct,
    annualMarketTrendPct: engineResult?.annualMarketTrendPct ?? 0,
    marketCell: engineResult?.marketCell ?? null,
    predictionInterval,
    modelDiagnostics,
    addressHistory,
    recentTransactions,
  };
}

async function buildParkingEstimate(input: BuildEstimateInput): Promise<MarketEstimate> {
  const commune = await fetchCommune(input.lat, input.lng);
  if (!commune?.departmentCode) {
    throw new Error("commune introuvable pour le stationnement");
  }
  const areaKind: "urban" | "rural" =
    commune.population >= URBAN_POPULATION_THRESHOLD ? "urban" : "rural";
  const detailedCommuneCode = officialDvfCommuneCode(commune.code, input.postalCode);
  const collection = await fetchDataGouvParkingCommune({
    location: { code: detailedCommuneCode, departmentCode: commune.departmentCode },
  });
  if (!collection?.sales.length) {
    throw new Error("aucune vente unitaire de stationnement exploitable dans la commune");
  }

  const radii = input.radiusOverride
    ? [input.radiusOverride]
    : areaKind === "urban"
      ? [500, 1_000, 2_000, 5_000]
      : [1_000, 2_500, 5_000, 10_000];
  const datedSales = collection.sales
    .filter((sale) => recentEnough(sale.date, 60))
    .map((sale) => ({
      ...sale,
      distanceM: Math.round(haversineMeters(input.lat, input.lng, sale.latitude, sale.longitude)),
    }));
  let radiusM = radii[0];
  let nearby = datedSales.filter((sale) => sale.distanceM <= radiusM);
  for (let index = 1; index < radii.length && nearby.length < 8; index += 1) {
    radiusM = radii[index];
    nearby = datedSales.filter((sale) => sale.distanceM <= radiusM);
  }
  if (!nearby.length) {
    throw new Error("aucune vente unitaire de stationnement assez proche");
  }

  const filtered = filterParkingOutliers(nearby);
  const selected = filtered.sales.length ? filtered.sales : nearby;
  const prices = selected.map((sale) => sale.unitPrice).sort((a, b) => a - b);
  const median = quantile(prices, 0.5);
  const empiricalP10 = quantile(prices, 0.1);
  const empiricalP90 = quantile(prices, 0.9);
  const low = Math.max(1_000, Math.min(empiricalP10, median * 0.5));
  const high = Math.max(empiricalP90, median * 1.8);
  const roundedMedian = roundTo(median, 500);
  const roundedLow = roundTo(low, 500);
  const roundedHigh = roundTo(high, 500);
  const qualityScore = Math.max(
    28,
    Math.min(64, 32 + Math.round(Math.log10(selected.length + 1) * 18)),
  );
  const qualityWarnings = [
    "estimation indicative fondée uniquement sur les mutations DVF composées de dépendances vendues seules",
    "la catégorie DVF dépendance ne distingue pas toujours parking, garage, box et cave : fourchette volontairement large",
  ];
  if (collection.missingYears.length) {
    qualityWarnings.unshift(
      `collecte incomplète : millésime(s) ${collection.missingYears.join(", ")}`,
    );
  }
  if (input.locationApproximate) {
    qualityWarnings.unshift("localisation communale approximative déduite de l’adresse");
  }

  return {
    source: "DVF data.gouv",
    sourceUrl: "https://www.data.gouv.fr/datasets/demandes-de-valeurs-foncieres-geolocalisees",
    sourceUpdatedAt: null,
    engineVersion: "v3",
    engineKind: "comparable_ensemble",
    modelVersionId: null,
    modelVersion: null,
    segment: "parking",
    surfaceBasis: "unit",
    estimationLevel: "indicative",
    subjectSurfaceM2: 1,
    subjectSurfaceEstimated: false,
    subjectSurfaceAssumption: "une place de stationnement",
    subjectSurfaceUncertaintyPct: null,
    locationSource: input.locationSource,
    locationApproximate: input.locationApproximate,
    estimatedValueEur: roundedMedian,
    estimatedValueLowEur: roundedLow,
    estimatedValueHighEur: roundedHigh,
    actionable: false,
    collectionComplete: collection.complete,
    missingYears: collection.missingYears,
    radiusM,
    yearsBack: 5,
    areaKind,
    commune: commune.nom,
    sampleSize: selected.length,
    effectiveSampleSize: selected.length,
    parcelSampleSize: nearby.length,
    totalNearbySampleSize: datedSales.length,
    outliersRemoved: filtered.removed,
    qualityScore,
    qualityLabel: qualityScore >= 58 ? "correcte" : "fragile",
    qualityWarnings,
    comparableMode: "unit_sales",
    geographyLevel: "commune",
    geographyCode: detailedCommuneCode,
    surfaceMinM2: null,
    surfaceMaxM2: null,
    landSurfaceMinM2: null,
    landSurfaceMaxM2: null,
    medianPricePerM2: null,
    p10PricePerM2: null,
    p25PricePerM2: null,
    p75PricePerM2: null,
    p90PricePerM2: null,
    minPricePerM2: null,
    maxPricePerM2: null,
    medianUnitPriceEur: roundedMedian,
    p10UnitPriceEur: roundedLow,
    p90UnitPriceEur: roundedHigh,
    deviationPct: null,
    annualMarketTrendPct: 0,
    marketCell: `parking:commune:${detailedCommuneCode}`,
    predictionInterval: undefined,
    modelDiagnostics: null,
    addressHistory: [],
    recentTransactions: selected
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 8)
      .map((sale) => ({
        date: sale.date,
        pricePerM2: Math.round(sale.unitPrice),
        surface: sale.unitCount,
        totalPrice: Math.round(sale.totalPrice),
        type: sale.unitCount > 1 ? `${sale.unitCount} dépendances` : "Dépendance seule",
        distanceM: sale.distanceM,
        unitCount: sale.unitCount,
      })),
  };
}

function filterParkingOutliers<T extends DataGouvParkingSale>(
  sales: T[],
): {
  sales: T[];
  removed: number;
} {
  if (sales.length < 8) return { sales, removed: 0 };
  const logs = sales.map((sale) => Math.log(sale.unitPrice)).sort((a, b) => a - b);
  const q1 = quantile(logs, 0.25);
  const q3 = quantile(logs, 0.75);
  const spread = q3 - q1;
  const lower = Math.exp(q1 - 1.5 * spread);
  const upper = Math.exp(q3 + 1.5 * spread);
  const filtered = sales.filter((sale) => sale.unitPrice >= lower && sale.unitPrice <= upper);
  return { sales: filtered, removed: sales.length - filtered.length };
}

function isParkingProperty(propertyType: string | null | undefined): boolean {
  return /parking|stationnement|garage|\bbox\b/i.test(propertyType ?? "");
}

function buildStatisticsMarketEstimate(input: {
  fallback: DvfMarketStatisticsFallback;
  segment: Exclude<MarketPropertySegment, "unsupported">;
  subjectSurface: number;
  subjectLandSurface: number | null;
  subjectSurfaceEstimated: boolean;
  subjectSurfaceAssumption: string | null;
  subjectSurfaceUncertaintyPct: number | null;
  locationSource: "provided" | "geocoded";
  locationApproximate: boolean;
  commune: string;
  radiusM: number;
  yearsBack: number;
  areaKind: "urban" | "rural";
  pricePerM2Ref: number | null | undefined;
}): MarketEstimate {
  const median = input.fallback.medianPricePerM2;
  const estimatedValueEur = Math.round((median * input.subjectSurface) / 1_000) * 1_000;
  const estimatedValueLowEur =
    Math.round((input.fallback.p10PricePerM2 * input.subjectSurface) / 1_000) * 1_000;
  const estimatedValueHighEur =
    Math.round((input.fallback.p90PricePerM2 * input.subjectSurface) / 1_000) * 1_000;
  const qualityWarnings = [...input.fallback.qualityWarnings];
  if (input.subjectSurfaceEstimated && input.subjectSurfaceAssumption) {
    qualityWarnings.unshift(input.subjectSurfaceAssumption);
  }
  if (input.locationSource === "geocoded") {
    qualityWarnings.unshift(
      input.locationApproximate
        ? "localisation communale approximative déduite de l’adresse"
        : "coordonnées déduites de l’adresse publiée",
    );
  }
  const deviationPct =
    input.pricePerM2Ref != null && input.pricePerM2Ref > 0
      ? ((input.pricePerM2Ref - median) / median) * 100
      : null;

  return {
    source: "Statistiques DVF data.gouv",
    sourceUrl: input.fallback.sourceUrl,
    sourceUpdatedAt: input.fallback.sourceUpdatedAt,
    engineVersion: "v3",
    engineKind: "comparable_ensemble",
    modelVersionId: null,
    modelVersion: null,
    segment: input.segment,
    surfaceBasis: input.segment === "land" ? "land" : "built",
    estimationLevel: "indicative",
    subjectSurfaceM2: input.subjectSurface,
    subjectSurfaceEstimated: input.subjectSurfaceEstimated,
    subjectSurfaceAssumption: input.subjectSurfaceAssumption,
    subjectSurfaceUncertaintyPct: input.subjectSurfaceUncertaintyPct,
    locationSource: input.locationSource,
    locationApproximate: input.locationApproximate,
    estimatedValueEur,
    estimatedValueLowEur,
    estimatedValueHighEur,
    actionable: false,
    collectionComplete: true,
    missingYears: [],
    radiusM: input.radiusM,
    yearsBack: input.yearsBack,
    areaKind: input.areaKind,
    commune: input.commune,
    sampleSize: input.fallback.salesCount,
    effectiveSampleSize: input.fallback.salesCount,
    parcelSampleSize: 0,
    totalNearbySampleSize: 0,
    outliersRemoved: 0,
    qualityScore: input.fallback.qualityScore,
    qualityLabel: "fragile",
    qualityWarnings,
    comparableMode: "geographic_aggregate",
    geographyLevel: input.fallback.geographyLevel,
    geographyCode: input.fallback.geographyCode,
    surfaceMinM2: null,
    surfaceMaxM2: null,
    landSurfaceMinM2: input.segment === "land" ? input.subjectLandSurface : null,
    landSurfaceMaxM2: input.segment === "land" ? input.subjectLandSurface : null,
    medianPricePerM2: median,
    p10PricePerM2: input.fallback.p10PricePerM2,
    p25PricePerM2: input.fallback.p25PricePerM2,
    p75PricePerM2: input.fallback.p75PricePerM2,
    p90PricePerM2: input.fallback.p90PricePerM2,
    minPricePerM2: input.fallback.p10PricePerM2,
    maxPricePerM2: input.fallback.p90PricePerM2,
    deviationPct,
    annualMarketTrendPct: 0,
    marketCell: `${input.fallback.geographyLevel}:${input.fallback.geographyCode}`,
    predictionInterval: {
      coverageTarget: 0.8,
      method: "geographic_aggregate_fallback",
      p10PricePerM2: input.fallback.p10PricePerM2,
      p50PricePerM2: median,
      p90PricePerM2: input.fallback.p90PricePerM2,
      conformalExpansionPct: Math.round((input.fallback.p90PricePerM2 / median - 1) * 1_000) / 10,
    },
    modelDiagnostics: null,
    addressHistory: [],
    recentTransactions: [],
  };
}

function radiiFor(
  segment: Exclude<MarketPropertySegment, "unsupported">,
  areaKind: "urban" | "rural",
): number[] {
  if (segment === "apartment")
    return areaKind === "urban" ? [150, 300, 600, 1_000, 2_000] : [300, 600, 1_000, 2_000, 5_000];
  if (segment === "house")
    return areaKind === "urban" ? [300, 600, 1_000, 2_000, 3_000] : [500, 1_000, 2_000, 5_000];
  if (segment === "building" || segment === "commercial") {
    return areaKind === "urban" ? [500, 1_000, 2_000, 3_000] : [1_000, 2_000, 5_000];
  }
  return areaKind === "urban" ? [500, 1_000, 2_000, 5_000] : [1_000, 2_000, 5_000, 10_000];
}

function assessEngineQuality({
  engineResult,
  actionable,
  collectionComplete,
  radiusM,
}: {
  engineResult: ReturnType<typeof analyzeMarketCandidates>;
  actionable: boolean;
  collectionComplete: boolean;
  radiusM: number;
}): Pick<MarketEstimate, "qualityScore" | "qualityLabel" | "qualityWarnings"> {
  if (!engineResult) {
    return {
      qualityScore: 0,
      qualityLabel: "fragile",
      qualityWarnings: ["aucune vente du même segment exploitable"],
    };
  }
  const averageScore =
    engineResult.comparables.reduce((sum, comparable) => sum + comparable.score, 0) /
    Math.max(1, engineResult.comparables.length);
  let qualityScore = 20 + Math.min(35, engineResult.effectiveSampleSize * 6) + averageScore * 0.35;
  if (engineResult.mode === "surface_land_matched") qualityScore += 8;
  if (engineResult.mode === "same_type_expanded") qualityScore -= 15;
  if (radiusM > 1_000) qualityScore -= 8;
  if (!collectionComplete) qualityScore -= 25;
  if (!actionable) qualityScore = Math.min(qualityScore, 54);
  qualityScore = Math.max(0, Math.min(100, Math.round(qualityScore)));
  return {
    qualityScore,
    qualityLabel: qualityScore >= 78 ? "forte" : qualityScore >= 58 ? "correcte" : "fragile",
    qualityWarnings: [...engineResult.warnings],
  };
}

export function marketEstimateCacheControl(context: MarketContext): string {
  const reliable = context.estimate?.actionable === true;
  if (!context.ok) return "private, max-age=60";
  return reliable
    ? "private, max-age=86400, stale-while-revalidate=604800"
    : "private, max-age=300";
}

export async function getMarketEstimate(
  input: unknown,
  audit?: { userId: string | null; auctionSaleId?: string | null },
): Promise<MarketContext> {
  const startedAt = Date.now();

  try {
    const data = inputSchema.parse(input);
    const location = await resolveMarketLocation({
      lat: data.lat,
      lng: data.lng,
      address: data.address,
      city: data.city,
      postalCode: data.postalCode,
    });
    const estimate = await buildEstimate({
      lat: location.lat,
      lng: location.lng,
      locationSource: location.source,
      locationApproximate: location.approximate,
      radiusOverride: data.radiusM ?? null,
      postalCode: data.postalCode,
      propertyType: data.propertyType,
      surfaceKind: data.surfaceKind,
      surfaceScope: data.surfaceScope,
      surfaceM2: data.surfaceM2,
      landSurfaceM2: data.landSurfaceM2,
      roomsCount: data.roomsCount,
      surfaceEstimated: data.surfaceEstimated ?? false,
      surfaceAssumption: data.surfaceAssumption ?? null,
      surfaceUncertaintyPct: data.surfaceUncertaintyPct ?? null,
      pricePerM2Ref: data.pricePerM2Ref,
    });

    const context = {
      ok: true,
      error: null,
      estimate,
      status: "ready",
      code: null,
      retryAfterSeconds: null,
      computedAt: new Date().toISOString(),
    } satisfies MarketContext;
    if (audit) {
      await recordValuationEstimate({
        userId: audit.userId,
        auctionSaleId: audit.auctionSaleId ?? data.saleId ?? null,
        modelVersionId: estimate.modelVersionId ?? null,
        engineVersion: estimate.engineVersion ?? "v3",
        engineKind: estimate.engineKind ?? "comparable_ensemble",
        segment: estimate.segment!,
        marketCell: estimate.marketCell ?? null,
        requestInput: data as Record<string, unknown>,
        result: estimate as Record<string, unknown>,
        valueP10Eur: estimate.estimatedValueLowEur ?? null,
        valueP50Eur: estimate.estimatedValueEur ?? null,
        valueP90Eur: estimate.estimatedValueHighEur ?? null,
        confidenceScore: estimate.qualityScore,
        comparableCount: estimate.sampleSize,
        actionable: estimate.actionable === true,
        latencyMs: Date.now() - startedAt,
      });
    }
    return context;
  } catch (err) {
    const message = err instanceof Error ? err.message : "erreur inconnue";
    const code = marketEstimateErrorCode(err);
    logMarketEstimateFailure(code, message, err);
    return {
      ok: false,
      error:
        code !== "UPSTREAM_UNAVAILABLE" && code !== "INTERNAL_ERROR"
          ? `Estimation automatique indisponible : ${message}.`
          : "Estimation de marché temporairement indisponible.",
      estimate: null,
      status:
        code === "UPSTREAM_UNAVAILABLE" || code === "INTERNAL_ERROR"
          ? "failed"
          : "insufficient_data",
      code,
      retryAfterSeconds: code === "UPSTREAM_UNAVAILABLE" ? 3600 : null,
      computedAt: null,
    };
  }
}

/**
 * Expected business outcomes (unsupported segment, missing surface, address
 * that cannot be geocoded, no comparable sale) are information, not incidents:
 * only real outages and unexpected errors are logged as errors.
 */
export function logMarketEstimateFailure(
  code: MarketEstimateErrorCode,
  message: string,
  error: unknown,
): void {
  if (code === "UPSTREAM_UNAVAILABLE" || code === "INTERNAL_ERROR") {
    console.error("DVF fetch failed", error);
    return;
  }
  console.info(JSON.stringify({ scope: "market-estimate", level: "info", code, message }));
}

export function marketEstimateErrorCode(error: unknown): MarketEstimateErrorCode {
  if (error instanceof z.ZodError) return "INVALID_INPUT";
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (/segment de bien|non pris en charge/.test(message)) return "UNSUPPORTED_SEGMENT";
  if (/surface compatible|surface.*manquante/.test(message)) return "MISSING_SURFACE";
  if (/adresse|coordonn|géocod|geocod/.test(message)) return "MISSING_LOCATION";
  if (/aucune vente|comparable|échantillon|echantillon/.test(message)) return "NO_COMPARABLES";
  if (/timeout|fetch|http |réseau|network|indisponible/.test(message))
    return "UPSTREAM_UNAVAILABLE";
  return "INTERNAL_ERROR";
}
