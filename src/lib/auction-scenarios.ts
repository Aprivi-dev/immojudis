/**
 * « Scénarios d'enchères » : ce que les trois dernières années d'adjudications
 * du tribunal disent d'une vente à venir. Licitor donne mise à prix et prix
 * final de chaque lot (d'où les scénarios), DVF les prix finaux officiels.
 * Shared by the API routes (server) and the components (browser).
 */

export type AuctionScenarioKey = "near_start" | "up_to_1_5" | "up_to_2" | "up_to_3" | "above_3";

export type AuctionScenario = {
  key: AuctionScenarioKey;
  lowRatio: number;
  highRatio: number | null;
  probability: number;
};

export type CourtLicitorHistory = {
  sample: number;
  firstSale: string | null;
  lastSale: string | null;
  meanStartingPrice: number | null;
  meanHammerPrice: number | null;
  medianStartingPrice: number | null;
  medianHammerPrice: number | null;
  medianRatio: number | null;
  aboveStartingRate: number | null;
  atLeastDoubleRate: number | null;
  byYear: Array<{ year: number; sales: number }>;
};

export type CourtDvfTypeHistory = {
  propertyType: string;
  sample: number;
  medianPrice: number | null;
  medianPricePerM2: number | null;
  surfaceSample: number;
};

export type CourtDvfHistory = {
  sample: number;
  firstDate: string | null;
  lastDate: string | null;
  meanPrice: number | null;
  medianPrice: number | null;
  byType: CourtDvfTypeHistory[];
};

export type AuctionScenarioSet = {
  /** Starting-price band (1: under 20 k€ … 5: 200 k€ and more). */
  band: number | null;
  courtSample: number;
  nationalSample: number;
  /** The price range comes from the court's own lots, or from the national ones. */
  priceScope: "court" | "national";
  scenarios: AuctionScenario[];
  ratioQuartiles: { q25: number | null; q50: number | null; q75: number | null };
};

export type AuctionScenariosResponse = {
  courtName: string | null;
  startingPrice: number | null;
  propertyType: string | null;
  surfaceM2: number | null;
  scenarios: AuctionScenarioSet | null;
  history: { licitor: CourtLicitorHistory | null; dvf: CourtDvfHistory | null };
};

export type CourtAuctionSummary = {
  courtCode: string;
  courtName: string;
  licitor: {
    sample: number;
    meanStartingPrice: number | null;
    meanHammerPrice: number | null;
    medianRatio: number | null;
    atLeastDoubleRate: number | null;
  } | null;
  dvf: { sample: number; medianPrice: number | null } | null;
};

export const AUCTION_SCENARIO_LABELS: Record<AuctionScenarioKey, string> = {
  near_start: "Adjugé à la mise à prix ou presque",
  up_to_1_5: "Jusqu’à 1,5 fois la mise à prix",
  up_to_2: "De 1,5 à 2 fois la mise à prix",
  up_to_3: "De 2 à 3 fois la mise à prix",
  above_3: "Plus de 3 fois la mise à prix",
};

export const STARTING_PRICE_BAND_LABELS: Record<number, string> = {
  1: "moins de 20 000 €",
  2: "20 000 à 50 000 €",
  3: "50 000 à 100 000 €",
  4: "100 000 à 200 000 €",
  5: "200 000 € et plus",
};

const KEYS = new Set<AuctionScenarioKey>(
  Object.keys(AUCTION_SCENARIO_LABELS) as AuctionScenarioKey[],
);

type Raw = Record<string, unknown> | null | undefined;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record).filter((item) => item !== null) : [];
}

export function mapScenarioSet(raw: Raw): AuctionScenarioSet | null {
  const value = record(raw);
  if (!value) return null;
  const scenarios = list(value.scenarios)
    .filter((item) => KEYS.has(item.key as AuctionScenarioKey))
    .map((item) => ({
      key: item.key as AuctionScenarioKey,
      lowRatio: num(item.low_ratio) ?? 0,
      highRatio: num(item.high_ratio),
      probability: Math.min(1, Math.max(0, num(item.probability) ?? 0)),
    }));
  const quartiles = record(value.ratio_quartiles) ?? {};
  if (!scenarios.length) return null;
  return {
    band: num(value.band),
    courtSample: num(value.court_sample) ?? 0,
    nationalSample: num(value.national_sample) ?? 0,
    priceScope: value.price_scope === "court" ? "court" : "national",
    scenarios,
    ratioQuartiles: { q25: num(quartiles.q25), q50: num(quartiles.q50), q75: num(quartiles.q75) },
  };
}

export function mapLicitorHistory(raw: Raw): CourtLicitorHistory | null {
  const value = record(raw);
  if (!value || !num(value.sample)) return null;
  return {
    sample: num(value.sample) ?? 0,
    firstSale: str(value.first_sale),
    lastSale: str(value.last_sale),
    meanStartingPrice: num(value.mean_starting_price),
    meanHammerPrice: num(value.mean_hammer_price),
    medianStartingPrice: num(value.median_starting_price),
    medianHammerPrice: num(value.median_hammer_price),
    medianRatio: num(value.median_ratio),
    aboveStartingRate: num(value.above_starting_rate),
    atLeastDoubleRate: num(value.at_least_double_rate),
    byYear: list(value.by_year)
      .map((item) => ({ year: num(item.year) ?? 0, sales: num(item.sales) ?? 0 }))
      .filter((item) => item.year > 0),
  };
}

export function mapDvfHistory(raw: Raw): CourtDvfHistory | null {
  const value = record(raw);
  if (!value || !num(value.sample)) return null;
  return {
    sample: num(value.sample) ?? 0,
    firstDate: str(value.first_date),
    lastDate: str(value.last_date),
    meanPrice: num(value.mean_price),
    medianPrice: num(value.median_price),
    byType: list(value.by_type).map((item) => ({
      propertyType: str(item.property_type) ?? "other",
      sample: num(item.sample) ?? 0,
      medianPrice: num(item.median_price),
      medianPricePerM2: num(item.median_price_per_m2),
      surfaceSample: num(item.surface_sample) ?? 0,
    })),
  };
}

export function mapCourtSummaries(raw: unknown): CourtAuctionSummary[] {
  return list(raw)
    .map((item) => {
      const licitor = record(item.licitor);
      const dvf = record(item.dvf);
      return {
        courtCode: str(item.court_code) ?? "",
        courtName: str(item.court_name) ?? str(item.court_code) ?? "",
        licitor: licitor
          ? {
              sample: num(licitor.sample) ?? 0,
              meanStartingPrice: num(licitor.mean_starting_price),
              meanHammerPrice: num(licitor.mean_hammer_price),
              medianRatio: num(licitor.median_ratio),
              atLeastDoubleRate: num(licitor.at_least_double_rate),
            }
          : null,
        dvf: dvf ? { sample: num(dvf.sample) ?? 0, medianPrice: num(dvf.median_price) } : null,
      };
    })
    .filter((item) => item.courtCode);
}

/** The type names used by the listings, matched with DVF's. */
const DVF_TYPE_BY_LISTING: Record<string, string> = {
  apartment: "apartment",
  studio: "apartment",
  house: "house",
  villa: "house",
  land: "land",
  commercial: "commercial",
  parking: "parking",
};

/** Official final price per m² of the same type at this court, when DVF has enough sales. */
export function dvfReferenceForType(
  dvf: CourtDvfHistory | null,
  propertyType: string | null,
  minimumSales = 10,
): CourtDvfTypeHistory | null {
  const wanted = propertyType ? DVF_TYPE_BY_LISTING[propertyType] : undefined;
  if (!dvf || !wanted) return null;
  const match = dvf.byType.find((item) => item.propertyType === wanted);
  return match && match.surfaceSample >= minimumSales && match.medianPricePerM2 ? match : null;
}

/** Probability of a final price of at least ``ratio`` times the starting price. */
export function probabilityAtLeast(scenarios: AuctionScenario[], ratio: number): number {
  return scenarios
    .filter((scenario) => scenario.lowRatio >= ratio)
    .reduce((sum, scenario) => sum + scenario.probability, 0);
}

const euro = new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});
const percent = new Intl.NumberFormat("fr-FR", { style: "percent", maximumFractionDigits: 0 });
const ratioFormat = new Intl.NumberFormat("fr-FR", {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
});

export function formatEuro(value: number | null | undefined): string {
  return value == null ? "—" : euro.format(Math.round(value / 1000) * 1000);
}

export function formatPercent(value: number | null | undefined): string {
  return value == null ? "—" : percent.format(value);
}

export function formatRatio(value: number | null | undefined): string {
  return value == null ? "—" : `×${ratioFormat.format(value)}`;
}
