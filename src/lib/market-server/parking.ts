import "server-only";
import { fetchDataGouvParkingCommune, type DataGouvParkingSale } from "@/lib/dvf-data-gouv";
import type { BuildEstimateInput, MarketEstimate } from "@/lib/market-server/types";
import { URBAN_POPULATION_THRESHOLD } from "@/lib/market-server/constants";
import { haversineMeters } from "@/lib/market-server/geometry";
import { quantile, roundTo } from "@/lib/market-server/numbers";
import { fetchCommune, officialDvfCommuneCode } from "@/lib/market-server/sources";
import { recentEnough } from "@/lib/market-server/radius-analysis";

export async function buildParkingEstimate(input: BuildEstimateInput): Promise<MarketEstimate> {
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

export function isParkingProperty(propertyType: string | null | undefined): boolean {
  return /parking|stationnement|garage|\bbox\b/i.test(propertyType ?? "");
}
