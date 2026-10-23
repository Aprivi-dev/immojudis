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

/**
 * Reliability of the figures, decided by the database (app_private.court_auction_scenarios) from the
 * number of comparable sales of the court itself (same starting-price band, same kind of property,
 * last three years):
 *   good   : 30 sales or more;
 *   medium : 10 to 29 sales (the court's rate is blended with the national one);
 *   low    : fewer than 10 sales (national rate only, announced as such).
 * Below MIN_NATIONAL_SAMPLE comparable sales in France there is no figure at all.
 */
export type ScenarioReliability = "low" | "medium" | "good";
export const MIN_NATIONAL_SAMPLE = 30;
export const MIN_COURT_SAMPLE = 10;
export const GOOD_COURT_SAMPLE = 30;
/** No scenario under this starting price (the lots of the base start above it). */
export const MIN_SCENARIO_STARTING_PRICE = 1_000;

export type AuctionScenarioSet = {
  /** "insufficient": fewer than MIN_NATIONAL_SAMPLE comparable sales, only the sample sizes are known. */
  status: "ok" | "insufficient";
  /** Starting-price band (1: under 20 k€ … 5: 200 k€ and more). */
  band: number | null;
  courtSample: number;
  nationalSample: number;
  /** The shares blend the court's lots with the national rate, or are the national rate alone. */
  basis: "court" | "national";
  reliability: ScenarioReliability | null;
  /** The price range comes from the court's own lots, or from the national ones. */
  priceScope: "court" | "national";
  scenarios: AuctionScenario[];
  ratioQuartiles: { q25: number | null; q50: number | null; q75: number | null };
};

/** Why a sale has no scenario figures (one message per cause). */
export type ScenariosUnavailableReason =
  | "no_starting_price"
  | "starting_price_too_low"
  | "no_court_code"
  | "insufficient_data";

export type AuctionScenariosResponse = {
  courtName: string | null;
  startingPrice: number | null;
  propertyType: string | null;
  scenarios: AuctionScenarioSet | null;
  /** Set when `scenarios` carries no figure. */
  unavailable: ScenariosUnavailableReason | null;
  /** Date of the copy of the lots the figures come from (ISO), when known. */
  dataAsOf: string | null;
  history: { licitor: CourtLicitorHistory | null; dvf: CourtDvfHistory | null };
};

export type CourtAuctionSummary = {
  courtCode: string;
  courtName: string;
  licitor: {
    sample: number;
    meanStartingPrice: number | null;
    meanHammerPrice: number | null;
    medianStartingPrice: number | null;
    medianHammerPrice: number | null;
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

export const RELIABILITY_LABELS: Record<ScenarioReliability, string> = {
  good: "bonne",
  medium: "moyenne",
  low: "faible",
};

export const RELIABILITY_EXPLANATIONS: Record<ScenarioReliability, string> = {
  good: `${GOOD_COURT_SAMPLE} ventes comparables ou plus au tribunal`,
  medium: `de ${MIN_COURT_SAMPLE} à ${GOOD_COURT_SAMPLE - 1} ventes comparables au tribunal, mêlées au taux des tribunaux couverts`,
  low: `moins de ${MIN_COURT_SAMPLE} ventes comparables au tribunal : les chiffres sont ceux des tribunaux couverts`,
};

/** What the comparison keeps, for a sentence: « des logements », « des parkings »… */
export const PROPERTY_GROUP_LABELS: Record<ScenarioPropertyGroup, string> = {
  housing: "des logements",
  parking: "des parkings",
  land: "des terrains",
  commercial: "des locaux d’activité",
};

export const STARTING_PRICE_BAND_LABELS: Record<number, string> = {
  1: "moins de 20 000 €",
  2: "20 000 à 50 000 €",
  3: "50 000 à 100 000 €",
  4: "100 000 à 200 000 €",
  5: "200 000 € et plus",
};

/**
 * Upper bounds (exclusive) of the starting-price bands 1 to 4; band 5 is everything above. Mirrors
 * `app_private.starting_price_band` (supabase/migrations/20261019100000); a test compares the two.
 */
export const STARTING_PRICE_BAND_UPPER_BOUNDS = [20_000, 50_000, 100_000, 200_000] as const;

/** Band of a starting price, as the database computes it (null without a positive price). */
export function startingPriceBand(startingPrice: number | null | undefined): number | null {
  if (startingPrice == null || !Number.isFinite(startingPrice) || startingPrice <= 0) return null;
  const index = STARTING_PRICE_BAND_UPPER_BOUNDS.findIndex((bound) => startingPrice < bound);
  return index === -1 ? STARTING_PRICE_BAND_UPPER_BOUNDS.length + 1 : index + 1;
}

/** A price inside each band (its lower edge, 1 000 € for band 1): the database reads the band only. */
export function representativeStartingPrice(band: number): number {
  return band <= 1 ? MIN_SCENARIO_STARTING_PRICE : STARTING_PRICE_BAND_UPPER_BOUNDS[band - 2];
}

export type ScenarioPropertyGroup = "housing" | "parking" | "land" | "commercial";

/**
 * Comparison group of a property type, as `app_private.scenario_property_group` computes it
 * (supabase/migrations/20261101120100). Null (building, mixed, other, unknown): all lots are compared.
 */
export function scenarioPropertyGroup(
  propertyType: string | null | undefined,
): ScenarioPropertyGroup | null {
  switch (propertyType) {
    case "apartment":
    case "studio":
    case "house":
    case "villa":
      return "housing";
    case "parking":
      return "parking";
    case "land":
      return "land";
    case "commercial":
      return "commercial";
    default:
      return null;
  }
}

/**
 * Percentages (integers) of shares that add up to exactly 100, by the largest-remainder method:
 * rounding each share on its own can total 99 or 101. Shares are normalised first (the database
 * rounds each probability to four decimals).
 */
export function largestRemainderPercentages(shares: number[]): number[] {
  const total = shares.reduce((sum, share) => sum + Math.max(0, share), 0);
  if (!shares.length || total <= 0) return shares.map(() => 0);
  const exact = shares.map((share) => (Math.max(0, share) / total) * 100);
  // Remainders are compared at 1e-9 so that float noise (8.799999999 vs 8.8) cannot reorder ties.
  const floors = exact.map((value) => Math.floor(value + 1e-9));
  let missing = 100 - floors.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, remainder: Math.round((value - floors[index]) * 1e9) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  const result = [...floors];
  for (const { index } of order) {
    if (missing <= 0) break;
    result[index] += 1;
    missing -= 1;
  }
  return result;
}

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
  const courtSample = num(value.court_sample) ?? 0;
  const nationalSample = num(value.national_sample) ?? 0;
  // Below the minimum there is no figure, whatever the database sent (an older function still
  // answered with figures from 3 sales).
  const insufficient =
    value.status === "insufficient" ||
    (value.national_sample != null && nationalSample < MIN_NATIONAL_SAMPLE);
  if (!insufficient && !scenarios.length) return null;
  const reliability = value.reliability;
  return {
    status: insufficient ? "insufficient" : "ok",
    band: num(value.band),
    courtSample,
    nationalSample,
    basis:
      value.basis === "court" || (value.basis == null && courtSample >= MIN_COURT_SAMPLE)
        ? "court"
        : "national",
    reliability:
      !insufficient && (reliability === "low" || reliability === "medium" || reliability === "good")
        ? reliability
        : null,
    priceScope: value.price_scope === "court" ? "court" : "national",
    scenarios: insufficient ? [] : scenarios,
    ratioQuartiles: insufficient
      ? { q25: null, q50: null, q75: null }
      : { q25: num(quartiles.q25), q50: num(quartiles.q50), q75: num(quartiles.q75) },
  };
}

/** « données au 22/10 » : day and month of the copy the figures come from (Paris time). */
export function formatDataAsOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Europe/Paris",
  }).format(date);
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
              medianStartingPrice: num(licitor.median_starting_price),
              medianHammerPrice: num(licitor.median_hammer_price),
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

/**
 * Official final price per m² of the same type at this court, when DVF has enough sales.
 * Not displayed for now (W3, point 17): the reference is a court-wide median with no sample size,
 * and the sale's surface can be a land surface; it waits for its redesign.
 */
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
