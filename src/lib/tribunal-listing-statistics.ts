import { z } from "zod";
import { publishedDay } from "@/lib/listing-evidence";
import {
  MARKET_GAP_BAND_MAX_INTERVAL_WIDTH_PCT,
  MARKET_GAP_BAND_MIN_COMPARABLES,
  MARKET_GAP_BAND_MIN_COMPARABLES_JACKKNIFE,
  MARKET_GAP_BAND_MIN_EFFECTIVE_SAMPLE,
  passesPublicMarketGapGate,
} from "@/lib/market-gap-band";
import {
  tribunalJudicialActivityHistoryMonthsSchema,
  type TribunalJudicialActivityHistoryMonths,
} from "@/lib/tribunal-judicial-activity";

export { TribunalCourtUnresolvedError } from "@/lib/tribunal-judicial-activity";

export const TRIBUNAL_LISTING_STATISTICS_SCHEMA_VERSION = "tribunal_listing_statistics_v2" as const;
/**
 * Observations minimales pour publier une médiane, un taux ou une part. Elles étaient 5 : à 5
 * observations, un taux de 60 % peut aussi bien être 23 % que 88 % (intervalle de Wilson à 95 %).
 */
export const TRIBUNAL_LISTING_STATISTICS_MIN_SAMPLE = 10;
/** Pour un sous-groupe (la répartition par type de bien) : les parts exigent 20 observations. */
export const TRIBUNAL_LISTING_STATISTICS_MIN_SUBGROUP_SAMPLE = 20;
/**
 * De 5 observations jusqu'au seuil de publication, une mesure continue (mise à prix, ratio, délai)
 * ne montre que la fourchette observée, minimum et maximum : jamais un point.
 */
export const TRIBUNAL_LISTING_STATISTICS_RANGE_MIN_SAMPLE = 5;
/** Le taux de surenchère n'est publié que si au moins la moitié des annonces ont une réponse connue. */
export const TRIBUNAL_LISTING_STATISTICS_MIN_OVERBID_COVERAGE = 0.5;
/** Quantile de la loi normale pour l'intervalle de Wilson à 95 %. */
const WILSON_Z_95 = 1.959964;

const isoDateTimeSchema = z.string().datetime({ offset: true });

export const tribunalListingStatisticsQuerySchema = z
  .object({
    courtCode: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .transform((value) => value.toLocaleLowerCase("fr-FR"))
      .refine((value) => /^[a-z0-9][a-z0-9:._-]*$/.test(value), {
        message: "Code tribunal invalide.",
      })
      .optional(),
    saleId: z.string().guid().optional(),
    historyMonths: z.preprocess(
      (value) => (value === undefined ? 3 : Number(value)),
      tribunalJudicialActivityHistoryMonthsSchema,
    ),
  })
  .strict()
  .refine((value) => Boolean(value.courtCode) !== Boolean(value.saleId), {
    message: "Fournissez exactement courtCode ou saleId.",
  });

/** Intervalle de Wilson à 95 % d'une part, entre 0 et 1. */
const wilsonIntervalSchema = z
  .object({ low: z.number().min(0).max(1), high: z.number().min(0).max(1) })
  .strict()
  .refine((interval) => interval.low <= interval.high, {
    message: "La borne basse de l’intervalle dépasse la borne haute.",
  });

const shareIntervalFields = {
  /** Bornes de l'intervalle de Wilson à 95 % de `share`. */
  shareLow: z.number().min(0).max(1),
  shareHigh: z.number().min(0).max(1),
};

/**
 * Mesure de l'activité des annonces : publiée (avec l'intervalle de Wilson quand c'est une part),
 * limitée à la fourchette observée (5 à 9 observations, sans valeur centrale) ou masquée.
 */
const listingMetricSchema = z
  .discriminatedUnion("status", [
    z
      .object({
        status: z.literal("published"),
        value: z.number().nonnegative(),
        sampleSize: z.number().int().nonnegative(),
        interval: wilsonIntervalSchema.nullable(),
      })
      .strict(),
    z
      .object({
        status: z.literal("range_only"),
        value: z.null(),
        min: z.number().nonnegative(),
        max: z.number().nonnegative(),
        sampleSize: z.number().int().nonnegative(),
      })
      .strict(),
    z
      .object({
        status: z.literal("insufficient_data"),
        value: z.null(),
        sampleSize: z.number().int().nonnegative(),
      })
      .strict(),
  ])
  .superRefine((metric, context) => {
    if (metric.status === "range_only" && metric.min > metric.max) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Le minimum observé dépasse le maximum observé.",
      });
    }
  });

const occupationStatusSchema = z.enum(["vacant", "occupied", "rented"]);
const occupationDistributionSchema = z
  .object({
    status: occupationStatusSchema,
    count: z.number().int().nonnegative(),
    share: z.number().min(0).max(1),
    ...shareIntervalFields,
  })
  .strict();

const occupationSchema = z
  .object({
    knownSales: z.number().int().nonnegative(),
    unknownSales: z.number().int().nonnegative(),
    distribution: z.array(occupationDistributionSchema).max(3),
  })
  .strict()
  .superRefine((occupation, context) => {
    const statuses = new Set<string>();
    let knownCount = 0;
    let shareTotal = 0;
    for (const [index, item] of occupation.distribution.entries()) {
      if (statuses.has(item.status)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["distribution", index, "status"],
          message: "Chaque statut d’occupation ne peut apparaître qu’une fois.",
        });
      }
      statuses.add(item.status);
      knownCount += item.count;
      shareTotal += item.share;
      const expectedShare = occupation.knownSales ? item.count / occupation.knownSales : 0;
      if (Math.abs(item.share - expectedShare) > 0.000001) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["distribution", index, "share"],
          message: "La part doit utiliser le dénominateur des ventes renseignées.",
        });
      }
    }
    if (knownCount !== occupation.knownSales) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["distribution"],
        message: "Les effectifs doivent totaliser les ventes renseignées.",
      });
    }
    const expectedTotal = occupation.knownSales ? 1 : 0;
    // Shares are serialized to six decimals by the builder. Three thirds
    // therefore sum to 0.999999, while each individual share still has to be
    // accurate to one millionth of its count denominator.
    if (Math.abs(shareTotal - expectedTotal) > 0.000003) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["distribution"],
        message: "Les parts doivent totaliser les ventes renseignées.",
      });
    }
  });

const propertyTypeShareSchema = z
  .object({
    propertyType: z.enum(["apartment", "house", "other"]),
    count: z.number().int().positive(),
    share: z.number().min(0).max(1),
    ...shareIntervalFields,
  })
  .strict();

const hearingCalendarEntrySchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    sales: z.number().int().positive(),
  })
  .strict();

const shareEntrySchema = z
  .object({
    city: z.string().min(1),
    count: z.number().int().positive(),
    share: z.number().min(0).max(1),
    ...shareIntervalFields,
  })
  .strict();

const lawyerShareSchema = z
  .object({
    name: z.string().min(1),
    count: z.number().int().positive(),
    share: z.number().min(0).max(1),
    ...shareIntervalFields,
  })
  .strict();

const upcomingListingSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().nullable(),
    city: z.string().nullable(),
    saleAt: isoDateTimeSchema,
    startingPriceEur: z.number().positive().nullable(),
    occupationStatus: occupationStatusSchema.nullable(),
    hasVisit: z.boolean(),
    sourceNames: z.array(z.string().min(1)),
  })
  .strict();

export const tribunalListingStatisticsResponseSchema = z
  .object({
    schemaVersion: z.literal(TRIBUNAL_LISTING_STATISTICS_SCHEMA_VERSION),
    court: z
      .object({
        code: z.string().min(1),
        name: z.string().min(1),
        judicialRegion: z.string().min(1).nullable(),
      })
      .strict(),
    period: z
      .object({
        historyMonths: tribunalJudicialActivityHistoryMonthsSchema,
        historyStart: isoDateTimeSchema,
        historyEnd: isoDateTimeSchema,
        asOf: isoDateTimeSchema,
      })
      .strict(),
    activity: z
      .object({
        observedAnnouncements: z.number().int().nonnegative(),
        publicationDatesKnown: z.number().int().nonnegative(),
        discoveryDatesUsed: z.number().int().nonnegative(),
        upcomingSales: z.number().int().nonnegative(),
        nextSaleAt: isoDateTimeSchema.nullable(),
        startingPriceEur: listingMetricSchema,
        startingPriceToDvfRatio: listingMetricSchema,
        propertyTypes: z.array(propertyTypeShareSchema).max(3),
        occupation: occupationSchema,
        visitCoverage: listingMetricSchema,
        overbidCoverage: listingMetricSchema,
        overbidsKnown: z.number().int().nonnegative(),
        overbidsUnknown: z.number().int().nonnegative(),
        publishedToHearingDays: listingMetricSchema,
        discoveryToHearingDays: listingMetricSchema,
        hearingCalendar: z.array(hearingCalendarEntrySchema).max(100),
        communes: z.array(shareEntrySchema).max(20),
        lawyers: z.array(lawyerShareSchema).max(20),
        upcomingListings: z.array(upcomingListingSchema).max(100),
      })
      .strict(),
    meta: z
      .object({
        generatedAt: isoDateTimeSchema,
        minSampleSize: z.literal(TRIBUNAL_LISTING_STATISTICS_MIN_SAMPLE),
        minSubgroupSampleSize: z.literal(TRIBUNAL_LISTING_STATISTICS_MIN_SUBGROUP_SAMPLE),
        minRangeSampleSize: z.literal(TRIBUNAL_LISTING_STATISTICS_RANGE_MIN_SAMPLE),
        minOverbidCoverage: z.literal(TRIBUNAL_LISTING_STATISTICS_MIN_OVERBID_COVERAGE),
        sources: z.array(z.string().min(1)),
        publicationDateBasis: z.literal("source_publication_date_or_first_seen_at"),
        deduplication: z.literal("canonical_id_source_url_strong_address"),
        rawAnnouncements: z.number().int().nonnegative(),
        deduplicatedAnnouncements: z.number().int().nonnegative(),
        unresolvedStrongAddressDuplicates: z.number().int().nonnegative(),
        // Past hearings of the cohort read from the Outcome Graph archive
        // because their announcement left the catalogue.
        archivedAnnouncements: z.number().int().nonnegative().optional(),
        outcomeGateApplied: z.literal(false),
        limitations: z.array(z.string().min(1)).min(1),
      })
      .strict(),
  })
  .strict()
  .superRefine((response, context) => {
    const activity = response.activity;
    if (
      activity.publicationDatesKnown + activity.discoveryDatesUsed !==
      activity.observedAnnouncements
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activity", "publicationDatesKnown"],
        message: "Les dates de publication doivent couvrir la cohorte observée.",
      });
    }
    if (
      activity.occupation.knownSales + activity.occupation.unknownSales !==
      activity.observedAnnouncements
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activity", "occupation"],
        message: "L’occupation doit couvrir la cohorte observée.",
      });
    }
    if (activity.overbidsKnown + activity.overbidsUnknown !== activity.observedAnnouncements) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activity", "overbidsKnown"],
        message: "Les observations de surenchère doivent couvrir la cohorte observée.",
      });
    }
  });

export type TribunalListingStatisticsHistoryMonths = TribunalJudicialActivityHistoryMonths;
export type TribunalListingStatisticsQuery = z.infer<typeof tribunalListingStatisticsQuerySchema>;
export type TribunalListingStatisticsMetric = z.infer<typeof listingMetricSchema>;
export type TribunalListingStatisticsResponse = z.infer<
  typeof tribunalListingStatisticsResponseSchema
>;

export type TribunalListingStatisticsCourt = {
  code: string;
  name: string;
  judicialRegion: string | null;
};

export type TribunalListingStatisticsMarketEstimate = {
  source?: string | null;
  estimatedValueEur?: number | null;
  actionable?: boolean;
  /** Nombre de ventes comparables retenues. */
  sampleSize?: number | null;
  /**
   * De quoi appliquer la porte de la bande publique (`passesPublicMarketGapGate`) : sans eux, le
   * ratio de la vente reste hors de la statistique.
   */
  effectiveSampleSize?: number | null;
  intervalMethod?: string | null;
  pricePerM2P10?: number | null;
  pricePerM2P50?: number | null;
  pricePerM2P90?: number | null;
  radiusM?: number | null;
  segment?: string | null;
  areaKind?: string | null;
};

export type TribunalListingStatisticsSale = {
  id: string;
  title?: string | null;
  city?: string | null;
  address?: string | null;
  sourceName?: string | null;
  sourceNames?: string[];
  sourceUrls?: string[];
  saleDate: string | null;
  status: string | null;
  startingPriceEur: number | null;
  propertyType?: string | null;
  visitDates: unknown;
  occupancyStatus?: string | null;
  lawyerName?: string | null;
  publicationAt?: string | null;
  firstSeenAt?: string | null;
  overbidStatus?: unknown;
  overbidEvidence?: unknown;
  marketEstimate?: TribunalListingStatisticsMarketEstimate | null;
  marketEstimateEligible?: boolean;
  unresolvedStrongAddressDuplicate?: boolean;
  /** False when visit dates are not kept for the row (Outcome Graph archive). */
  visitInformationAvailable?: boolean;
  historySource?: "catalogue" | "outcome_graph_archive";
};

type ParsedSale = Omit<
  TribunalListingStatisticsSale,
  "saleDate" | "publicationAt" | "firstSeenAt"
> & {
  saleAt: Date;
  publicationAt: Date;
  publicationDateKnown: boolean;
  firstSeenAtDate: Date | null;
};

export function tribunalListingStatisticsPeriod(
  asOf: Date,
  historyMonths: TribunalListingStatisticsHistoryMonths,
): { historyStart: Date; historyEnd: Date } {
  assertValidDate(asOf, "asOf");
  return {
    historyStart: addUtcCalendarMonths(asOf, -historyMonths),
    historyEnd: asOf,
  };
}

export function buildTribunalListingStatistics(input: {
  court: TribunalListingStatisticsCourt;
  sales: TribunalListingStatisticsSale[];
  asOf: Date;
  historyMonths: TribunalListingStatisticsHistoryMonths;
  generatedAt?: Date;
  rawAnnouncements?: number;
  unresolvedStrongAddressDuplicates?: number;
}): TribunalListingStatisticsResponse {
  const { historyStart, historyEnd } = tribunalListingStatisticsPeriod(
    input.asOf,
    input.historyMonths,
  );
  const generatedAt = input.generatedAt ?? input.asOf;
  assertValidDate(generatedAt, "generatedAt");

  const seenIds = new Set<string>();
  const observed: ParsedSale[] = [];
  for (const sale of input.sales) {
    if (seenIds.has(sale.id))
      throw new Error("Duplicate sale in tribunal listing statistics input.");
    seenIds.add(sale.id);
    const saleAt = parseDate(sale.saleDate);
    const firstSeenAtDate = parseDate(sale.firstSeenAt);
    const explicitPublicationAt = parseDate(sale.publicationAt);
    const publicationAt = explicitPublicationAt ?? firstSeenAtDate;
    if (!saleAt || !publicationAt) continue;
    // A source publication date in the future is not a usable cohort anchor.
    // A durable first_seen_at remains a safe discovery fallback in that case.
    const usablePublicationAt =
      explicitPublicationAt && explicitPublicationAt <= input.asOf
        ? explicitPublicationAt
        : firstSeenAtDate;
    if (
      !usablePublicationAt ||
      usablePublicationAt < historyStart ||
      usablePublicationAt >= historyEnd
    ) {
      continue;
    }
    const status = sale.status?.toLocaleLowerCase("fr-FR");
    if (status !== "upcoming" && status !== "past" && status !== "adjudicated") continue;
    observed.push({
      ...sale,
      saleAt,
      publicationAt: usablePublicationAt,
      publicationDateKnown: Boolean(explicitPublicationAt && explicitPublicationAt <= input.asOf),
      firstSeenAtDate,
    });
  }

  const upcoming = observed
    .filter(
      (sale) => sale.status?.toLocaleLowerCase("fr-FR") === "upcoming" && sale.saleAt >= input.asOf,
    )
    .sort(
      (left, right) =>
        left.saleAt.getTime() - right.saleAt.getTime() || left.id.localeCompare(right.id),
    );
  const upcoming90End = new Date(input.asOf.getTime() + 90 * 24 * 60 * 60 * 1_000);
  const prices = observed.flatMap((sale) => {
    const value = positiveNumber(sale.startingPriceEur);
    return value == null ? [] : [value];
  });
  const ratioValues = observed.flatMap((sale) => {
    const price = positiveNumber(sale.startingPriceEur);
    const estimated = positiveNumber(sale.marketEstimate?.estimatedValueEur ?? null);
    if (
      price == null ||
      estimated == null ||
      sale.marketEstimateEligible !== true ||
      sale.marketEstimate?.actionable !== true ||
      !isDvfSource(sale.marketEstimate?.source) ||
      !passesBandGate(sale.marketEstimate)
    ) {
      return [];
    }
    return [price / estimated];
  });
  const knownPropertySales = observed.filter(
    (sale) => normalizePropertyType(sale.propertyType) != null,
  );
  const occupation = buildOccupation(observed);
  const overbidResults = observed.map((sale) =>
    classifyOverbid(sale.overbidStatus, sale.overbidEvidence),
  );
  const knownOverbids = overbidResults.filter((value): value is boolean => value !== null);
  const overbidTrueCount = knownOverbids.filter(Boolean).length;
  // Archived rows do not keep visit dates; they are left out of the
  // denominator rather than counted as "no visit announced".
  const visitObservable = observed.filter((sale) => sale.visitInformationAvailable !== false);
  const visits = visitObservable.filter((sale) => hasVisitDate(sale.visitDates)).length;
  const publicationLeadDays = observed.flatMap((sale) => {
    if (!sale.publicationDateKnown) return [];
    return nonNegativeDays(sale.publicationAt, sale.saleAt);
  });
  const discoveryLeadDays = observed.flatMap((sale) => {
    if (!sale.firstSeenAtDate) return [];
    return nonNegativeDays(sale.firstSeenAtDate, sale.saleAt);
  });

  const response: TribunalListingStatisticsResponse = {
    schemaVersion: TRIBUNAL_LISTING_STATISTICS_SCHEMA_VERSION,
    court: input.court,
    period: {
      historyMonths: input.historyMonths,
      historyStart: historyStart.toISOString(),
      historyEnd: historyEnd.toISOString(),
      asOf: input.asOf.toISOString(),
    },
    activity: {
      observedAnnouncements: observed.length,
      publicationDatesKnown: observed.filter((sale) => sale.publicationDateKnown).length,
      discoveryDatesUsed: observed.filter((sale) => !sale.publicationDateKnown).length,
      upcomingSales: upcoming.length,
      nextSaleAt: upcoming[0]?.saleAt.toISOString() ?? null,
      startingPriceEur: continuousMetric(prices),
      startingPriceToDvfRatio: continuousMetric(ratioValues),
      propertyTypes: propertyTypeShares(knownPropertySales),
      occupation,
      visitCoverage: proportionMetric(visits, visitObservable.length),
      // Le taux n'a de sens que si au moins la moitié des annonces ont une réponse connue : sinon il
      // ne décrit que les annonces où la surenchère se voit, pas le tribunal.
      overbidCoverage:
        observed.length > 0 &&
        knownOverbids.length / observed.length >= TRIBUNAL_LISTING_STATISTICS_MIN_OVERBID_COVERAGE
          ? proportionMetric(overbidTrueCount, knownOverbids.length)
          : { status: "insufficient_data", value: null, sampleSize: knownOverbids.length },
      overbidsKnown: knownOverbids.length,
      overbidsUnknown: observed.length - knownOverbids.length,
      publishedToHearingDays: continuousMetric(publicationLeadDays),
      discoveryToHearingDays: continuousMetric(discoveryLeadDays),
      hearingCalendar: hearingCalendar(upcoming, upcoming90End),
      communes: shareEntries(observed, (sale) => normalizeCityLabel(sale.city)),
      lawyers: lawyerShares(observed),
      upcomingListings: upcoming.slice(0, 100).map((sale) => ({
        id: sale.id,
        title: sale.title ?? null,
        city: normalizeCityLabel(sale.city),
        saleAt: sale.saleAt.toISOString(),
        startingPriceEur: positiveNumber(sale.startingPriceEur),
        occupationStatus: normalizeOccupationStatus(sale.occupancyStatus),
        hasVisit: hasVisitDate(sale.visitDates),
        sourceNames: sourceNames(sale),
      })),
    },
    meta: {
      generatedAt: generatedAt.toISOString(),
      minSampleSize: TRIBUNAL_LISTING_STATISTICS_MIN_SAMPLE,
      minSubgroupSampleSize: TRIBUNAL_LISTING_STATISTICS_MIN_SUBGROUP_SAMPLE,
      minRangeSampleSize: TRIBUNAL_LISTING_STATISTICS_RANGE_MIN_SAMPLE,
      minOverbidCoverage: TRIBUNAL_LISTING_STATISTICS_MIN_OVERBID_COVERAGE,
      sources: [...new Set(observed.flatMap((sale) => sourceNames(sale)))].sort((a, b) =>
        a.localeCompare(b, "fr"),
      ),
      publicationDateBasis: "source_publication_date_or_first_seen_at",
      deduplication: "canonical_id_source_url_strong_address",
      rawAnnouncements: input.rawAnnouncements ?? input.sales.length,
      deduplicatedAnnouncements: input.sales.length,
      unresolvedStrongAddressDuplicates: input.unresolvedStrongAddressDuplicates ?? 0,
      archivedAnnouncements: observed.filter(
        (sale) => sale.historySource === "outcome_graph_archive",
      ).length,
      outcomeGateApplied: false,
      limitations: [
        "La cohorte regroupe les annonces publiées ou découvertes par Immojudis pendant la période demandée; elle ne prétend pas à l’exhaustivité nationale.",
        "Les annonces sans date de publication fiable utilisent first_seen_at et sont comptées séparément.",
        `Les ratios DVF utilisent uniquement les estimations pré-calculées, fraîches, actionnables et issues de DVF qui passent la porte de la bande publique de la fiche : au moins ${MARKET_GAP_BAND_MIN_COMPARABLES_JACKKNIFE} ventes comparables avec la méthode jackknife (${MARKET_GAP_BAND_MIN_COMPARABLES} sinon), échantillon effectif d’au moins ${MARKET_GAP_BAND_MIN_EFFECTIVE_SAMPLE}, fourchette d’au plus ${MARKET_GAP_BAND_MAX_INTERVAL_WIDTH_PCT} % de la valeur, rayon borné.`,
        "Les taux de surenchère reposent uniquement sur des occurrences factuelles explicites; l’absence de preuve reste inconnue. Le taux n’est publié que si au moins la moitié des annonces ont une réponse connue.",
        `Les médianes et les taux sont publiés à partir de ${TRIBUNAL_LISTING_STATISTICS_MIN_SAMPLE} observations ; de ${TRIBUNAL_LISTING_STATISTICS_RANGE_MIN_SAMPLE} à ${TRIBUNAL_LISTING_STATISTICS_MIN_SAMPLE - 1}, seule la fourchette observée (minimum et maximum) est montrée. Les parts portent leur intervalle de Wilson à 95 % ; la répartition par type de bien exige ${TRIBUNAL_LISTING_STATISTICS_MIN_SUBGROUP_SAMPLE} observations.`,
        "Deux délais sont distincts : « publication → audience » part de la date de publication fournie par la source ; « première détection → audience » part du jour où Immojudis a repéré l’annonce pour la première fois, et peut donc être plus court.",
        "Les audiences passées dont l’annonce a quitté le catalogue proviennent de l’archive du graphe des résultats : sans statut de vérification ni dates de visite, elles sont exclues du taux de visites.",
      ],
    },
  };
  return tribunalListingStatisticsResponseSchema.parse(response);
}

function buildOccupation(sales: ParsedSale[]) {
  const counts = new Map<"vacant" | "occupied" | "rented", number>();
  let knownSales = 0;
  for (const sale of sales) {
    const status = normalizeOccupationStatus(sale.occupancyStatus);
    if (!status) continue;
    counts.set(status, (counts.get(status) ?? 0) + 1);
    knownSales += 1;
  }
  const statuses = ["vacant", "occupied", "rented"] as const;
  return {
    knownSales,
    unknownSales: sales.length - knownSales,
    distribution: statuses
      .map((status) => ({
        status,
        count: counts.get(status) ?? 0,
        share: knownSales ? round((counts.get(status) ?? 0) / knownSales, 6) : 0,
        ...shareInterval(counts.get(status) ?? 0, knownSales),
      }))
      .filter((entry) => entry.count > 0),
  };
}

export function normalizeOccupationStatus(
  value: string | null | undefined,
): "vacant" | "occupied" | "rented" | null {
  const normalized = value?.trim().toLocaleLowerCase("fr-FR");
  if (!normalized || normalized === "unknown") return null;
  if (normalized === "vacant" || /inoccup|libre/.test(normalized)) return "vacant";
  if (normalized === "rented" || normalized === "tenant_occupied" || /lou[eé]/.test(normalized)) {
    return "rented";
  }
  if (
    normalized === "occupied" ||
    normalized === "owner_occupied" ||
    normalized === "squatted" ||
    /occup|proprietaire|propriétaire|squat/.test(normalized)
  ) {
    return "occupied";
  }
  return null;
}

export function hasVisitDate(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some((item) => typeof item === "string" && publishedVisitDay(item) !== null)
  );
}

function publishedVisitDay(value: string): string | null {
  const parsed = publishedDay(value);
  if (parsed) return parsed;
  const match = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(value);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day, 12));
  return candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day
    ? candidate.toISOString().slice(0, 10)
    : null;
}

function normalizePropertyType(
  value: string | null | undefined,
): "apartment" | "house" | "other" | null {
  const normalized = value?.trim().toLocaleLowerCase("fr-FR");
  if (!normalized || normalized === "unknown") return null;
  if (/appartement|apartment|studio|loft/.test(normalized)) return "apartment";
  if (/maison|house|villa|pavillon/.test(normalized)) return "house";
  return "other";
}

function propertyTypeShares(sales: ParsedSale[]) {
  const counts = new Map<"apartment" | "house" | "other", number>();
  for (const sale of sales) {
    const type = normalizePropertyType(sale.propertyType);
    if (type) counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  const denominator = [...counts.values()].reduce((total, count) => total + count, 0);
  return (["apartment", "house", "other"] as const)
    .map((propertyType) => ({
      propertyType,
      count: counts.get(propertyType) ?? 0,
      share: denominator ? round((counts.get(propertyType) ?? 0) / denominator, 6) : 0,
      ...shareInterval(counts.get(propertyType) ?? 0, denominator),
    }))
    .filter((entry) => entry.count > 0)
    .sort(
      (left, right) =>
        right.count - left.count || left.propertyType.localeCompare(right.propertyType),
    );
}

function shareEntries(
  sales: ParsedSale[],
  getValue: (sale: ParsedSale) => string | null | undefined,
) {
  const counts = new Map<string, { display: string; count: number }>();
  for (const sale of sales) {
    const value = getValue(sale)?.trim();
    if (!value) continue;
    const key = labelFingerprint(value);
    const current = counts.get(key);
    if (current) current.count += 1;
    else counts.set(key, { display: value, count: 1 });
  }
  const denominator = [...counts.values()].reduce((total, entry) => total + entry.count, 0);
  return [...counts.values()]
    .sort(
      (left, right) => right.count - left.count || left.display.localeCompare(right.display, "fr"),
    )
    .slice(0, 20)
    .map(({ display, count }) => ({
      city: display,
      count,
      share: round(count / denominator, 6),
      ...shareInterval(count, denominator),
    }));
}

function normalizeCityLabel(value: string | null | undefined): string | null {
  const display = value?.trim();
  if (!display) return null;
  const normalized = labelFingerprint(display);
  // Some source cards put a property-purpose sentence in the commune field,
  // for example "USAGE D'HABITATION à Targon". Keep the raw value out of
  // aggregates instead of inferring the trailing place name.
  if (
    /\busage\s+(?:d\s+)?habitation\b/.test(normalized) ||
    /^(?:a|au|aux)\s+(?:usage|destination)\b/.test(normalized) ||
    /^(?:usage|destination)\b/.test(normalized)
  ) {
    return null;
  }
  return display;
}

function labelFingerprint(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr-FR")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function lawyerShares(sales: ParsedSale[]) {
  const counts = new Map<string, number>();
  for (const sale of sales) {
    const name = normalizeLawyerName(sale.lawyerName);
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const denominator = [...counts.values()].reduce((total, count) => total + count, 0);
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "fr"))
    .slice(0, 20)
    .map(([name, count]) => ({
      name,
      count,
      share: round(count / denominator, 6),
      ...shareInterval(count, denominator),
    }));
}

function normalizeLawyerName(value: string | null | undefined): string | null {
  const display = value?.trim();
  if (!display) return null;
  const normalized = labelFingerprint(display);
  const hasProfessionalIdentity = /\b(?:maitre|me|cabinet|scp)\b/.test(normalized);
  if (hasProfessionalIdentity) return display;

  // These are procedural instructions emitted by some source pages, not the
  // name of the lawyer representing the sale.
  if (
    (/(?:^|\b)encheres\b.*\b(?:pourront|devront|portees?|etre portees?)\b/.test(normalized) &&
      /\b(?:ministere\s+d\s+avocat|barreau)\b/.test(normalized)) ||
    /^(?:le\s+)?ministere\s+d\s+avocat\b/.test(normalized) ||
    /^avocat(?:e)?\s+(?:inscrit|inscrite|au\s+barreau)\b/.test(normalized) ||
    /^barreau\b/.test(normalized)
  ) {
    return null;
  }
  return display;
}

function hearingCalendar(sales: ParsedSale[], end: Date) {
  const counts = new Map<string, number>();
  for (const sale of sales) {
    if (sale.saleAt >= end) continue;
    const date = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Paris",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(sale.saleAt);
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, salesCount]) => ({ date, sales: salesCount }));
}

function classifyOverbid(status: unknown, evidence: unknown): boolean | null {
  const explicit = explicitOverbidStatus(status);
  if (explicit !== null) return explicit;
  const text = flattenText(evidence).join(" ").trim().toLocaleLowerCase("fr-FR");
  if (
    /(?:pas|aucune|sans)\s+(?:de\s+)?(?:vente|audience)\s+sur\s+surench[eè]re/.test(text) ||
    /surench[eè]re\s+(?:possible|facult[eé]|autoris[ée]e|sous\s+\d+\s*%|dans\s+les?)/.test(text)
  ) {
    return null;
  }
  if (
    /(?:vente|audience)\s+sur\s+surench[eè]re|surench[eè]re\s+(?:d[ée]pos[ée]e|form[ée]e|introduite|enregistr[ée]e)/.test(
      text,
    )
  ) {
    return true;
  }
  return null;
}

function explicitOverbidStatus(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return explicitOverbidLabel(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of ["overbidStatus", "overbid_status", "surenchereStatus", "surenchere_status"]) {
    const candidate = record[key];
    if (typeof candidate === "boolean") return candidate;
    if (typeof candidate === "string") {
      const parsed = explicitOverbidLabel(candidate);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

function explicitOverbidLabel(value: string): boolean | null {
  const normalized = value.trim().toLocaleLowerCase("fr-FR");
  if (/^(?:filed|surenchere_filed|observed)$/.test(normalized)) return true;
  if (/^(?:not_filed|none|deadline_expired)$/.test(normalized)) return false;
  return null;
}

function flattenText(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => flattenText(item));
  if (value && typeof value === "object")
    return Object.values(value as Record<string, unknown>).flatMap(flattenText);
  return [];
}

function sourceNames(
  sale: Pick<TribunalListingStatisticsSale, "sourceNames" | "sourceName">,
): string[] {
  const names = sale.sourceNames?.filter((value) => value.trim()) ?? [];
  if (sale.sourceName?.trim()) names.push(sale.sourceName.trim());
  return [...new Set(names)].sort((a, b) => a.localeCompare(b, "fr"));
}

function isDvfSource(value: string | null | undefined): boolean {
  return Boolean(value && /^dvf(?:\s|$)/i.test(value.trim()));
}

function nonNegativeDays(from: Date, to: Date): number[] {
  const days = (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1_000);
  return Number.isFinite(days) && days >= 0 && days <= 730 ? [days] : [];
}

/**
 * Mesure continue (mise à prix, ratio, délai) : médiane dès 10 observations ; de 5 à 9, seulement la
 * fourchette observée (minimum et maximum), jamais un point ; en dessous, rien.
 */
function continuousMetric(values: number[]): TribunalListingStatisticsMetric {
  const finite = values.filter(Number.isFinite);
  const sampleSize = finite.length;
  if (sampleSize < TRIBUNAL_LISTING_STATISTICS_RANGE_MIN_SAMPLE) {
    return { status: "insufficient_data", value: null, sampleSize };
  }
  if (sampleSize < TRIBUNAL_LISTING_STATISTICS_MIN_SAMPLE) {
    return {
      status: "range_only",
      value: null,
      min: round(Math.min(...finite), 4),
      max: round(Math.max(...finite), 4),
      sampleSize,
    };
  }
  return { status: "published", value: round(median(finite)!, 4), sampleSize, interval: null };
}

/** Part observée (dénominateur connu) : publiée dès 10 observations, avec son intervalle de Wilson. */
function proportionMetric(successes: number, total: number): TribunalListingStatisticsMetric {
  if (total < TRIBUNAL_LISTING_STATISTICS_MIN_SAMPLE) {
    return { status: "insufficient_data", value: null, sampleSize: total };
  }
  return {
    status: "published",
    value: round(successes / total, 4),
    sampleSize: total,
    interval: wilsonInterval(successes, total),
  };
}

/**
 * Intervalle de Wilson à 95 % d'une part (`successes` sur `total`), entre 0 et 1, arrondi au
 * millionième. Il reste correct pour de petits effectifs et près de 0 ou de 1, contrairement à
 * l'intervalle normal. `null` sans dénominateur.
 */
export function wilsonInterval(
  successes: number,
  total: number,
): { low: number; high: number } | null {
  if (!Number.isInteger(total) || total <= 0 || !Number.isInteger(successes)) return null;
  if (successes < 0 || successes > total) return null;
  const proportion = successes / total;
  const z2 = WILSON_Z_95 * WILSON_Z_95;
  const denominator = 1 + z2 / total;
  const centre = (proportion + z2 / (2 * total)) / denominator;
  const margin =
    (WILSON_Z_95 * Math.sqrt((proportion * (1 - proportion)) / total + z2 / (4 * total * total))) /
    denominator;
  return {
    low: round(Math.max(0, centre - margin), 6),
    high: round(Math.min(1, centre + margin), 6),
  };
}

/** Bornes de Wilson d'une part, sous les noms des champs de réponse. */
function shareInterval(count: number, total: number): { shareLow: number; shareHigh: number } {
  const interval = wilsonInterval(count, total) ?? { low: 0, high: 1 };
  return { shareLow: interval.low, shareHigh: interval.high };
}

/**
 * Le ratio mise à prix / DVF passe la même porte que la bande publique de la fiche : sans les
 * champs de qualité de l'estimation, la vente reste hors de la statistique.
 */
function passesBandGate(estimate: TribunalListingStatisticsMarketEstimate | null | undefined) {
  if (!estimate) return false;
  return passesPublicMarketGapGate({
    actionable: estimate.actionable,
    comparableCount: estimate.sampleSize,
    effectiveSampleSize: estimate.effectiveSampleSize,
    intervalMethod: estimate.intervalMethod,
    p10: estimate.pricePerM2P10,
    p50: estimate.pricePerM2P50,
    p90: estimate.pricePerM2P90,
    radiusM: estimate.radiusM,
    segment: estimate.segment,
    areaKind: estimate.areaKind,
  });
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const position = (ordered.length - 1) / 2;
  const lower = ordered[Math.floor(position)]!;
  const upper = ordered[Math.ceil(position)]!;
  return lower + (upper - lower) * (position - Math.floor(position));
}

function positiveNumber(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const candidate = new Date(value);
  return Number.isFinite(candidate.getTime()) ? candidate : null;
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function assertValidDate(value: Date, label: string): void {
  if (!Number.isFinite(value.getTime())) throw new Error(`${label} must be a valid date.`);
}

function addUtcCalendarMonths(value: Date, months: number): Date {
  const target = new Date(
    Date.UTC(
      value.getUTCFullYear(),
      value.getUTCMonth() + months,
      1,
      value.getUTCHours(),
      value.getUTCMinutes(),
      value.getUTCSeconds(),
      value.getUTCMilliseconds(),
    ),
  );
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(value.getUTCDate(), lastDay));
  return target;
}
