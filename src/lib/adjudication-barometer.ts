import type { AdjudicationPriceStatisticsScope } from "./adjudication-price-statistics";
import type { AdjudicationDistribution } from "./adjudication-distributions";

export const propertyTypeLabels: Record<string, string> = {
  apartment: "Appartement",
  house: "Maison",
  building: "Immeuble",
  commercial: "Local commercial",
  land: "Terrain",
  parking: "Parking",
  mixed: "Bien mixte",
};

export function distributionRates(distribution: AdjudicationDistribution) {
  const count = (band: string) =>
    distribution.bidDistribution.find((item) => item.band === band)?.count ?? 0;
  return {
    aboveStartingRate:
      (distribution.sampleSize - count("below_starting") - count("at_starting")) /
      distribution.sampleSize,
    atLeastDoubleRate: count("at_least_2") / distribution.sampleSize,
  };
}

export type TribunalSort = "sample" | "ratio" | "hammer" | "name";
export function filterAdjudicationTribunals(
  tribunals: AdjudicationPriceStatisticsScope[],
  filters: { search: string; region: string; minimumSample: number; sort: TribunalSort },
) {
  const normalize = (value: string) =>
    value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase("fr-FR")
      .trim();
  const query = normalize(filters.search);
  return tribunals
    .filter(
      (scope) =>
        scope.sampleSize >= filters.minimumSample &&
        (!filters.region || scope.judicialRegion === filters.region) &&
        normalize(`${scope.label} ${scope.courtCode} ${scope.judicialRegion ?? ""}`).includes(
          query,
        ),
    )
    .sort((a, b) => {
      const numeric =
        filters.sort === "sample"
          ? b.sampleSize - a.sampleSize
          : filters.sort === "ratio"
            ? b.metrics.medianHammerToStartingRatio - a.metrics.medianHammerToStartingRatio
            : filters.sort === "hammer"
              ? b.metrics.medianHammerPriceEur - a.metrics.medianHammerPriceEur
              : 0;
      return numeric || a.label.localeCompare(b.label, "fr");
    });
}

export function tribunalComparisonCsv(scopes: AdjudicationPriceStatisticsScope[]): string {
  // Spreadsheet formulas must remain plain text, even if a stored label is malformed.
  const cell = (value: string | number) => {
    const raw = String(value);
    const safe = /^[\s]*[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const rows = [
    [
      "Tribunal",
      "Code",
      "Ressort judiciaire",
      "Début",
      "Fin",
      "Prix publiés",
      "Multiple médian",
      "Mise à prix médiane EUR",
      "Prix adjugé médian EUR",
      "Au-dessus de la mise (proportion)",
      "Au moins le double (proportion)",
      "Source",
    ],
    ...scopes.map((scope) => [
      scope.label,
      scope.courtCode ?? "",
      scope.judicialRegion ?? "",
      scope.periodStart,
      scope.periodEnd,
      scope.sampleSize,
      scope.metrics.medianHammerToStartingRatio,
      scope.metrics.medianStartingPriceEur,
      scope.metrics.medianHammerPriceEur,
      scope.metrics.aboveStartingRate,
      scope.metrics.atLeastDoubleRate,
      "Licitor — prix publiés, hors frais, non définitifs",
    ]),
  ];
  return "\uFEFF" + rows.map((row) => row.map(cell).join(";")).join("\r\n");
}
