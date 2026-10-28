// zod/mini : la réponse est validée aussi dans le navigateur (annuaire de l'activité judiciaire,
// statistiques de la fiche). Mêmes règles que l'écriture chaînée de zod (objets `strict` devenus
// `strictObject`, `.refine` devenu `.check(z.refine(...))`), avec bien moins de code envoyé.
import { z } from "zod/mini";
import { publishedDay } from "@/lib/listing-evidence";
import { TRIBUNAL_STATISTICS_RANGE_MIN_SAMPLE } from "@/lib/tribunal-publication-thresholds";
import { labelFingerprint, parisDayKey } from "@/lib/tribunal-hearing-identity";
import { mergeDuplicateJudicialAnnouncements } from "@/lib/tribunal-judicial-activity-dedup";

export class TribunalCourtUnresolvedError extends Error {
  constructor(message = "Le rattachement exact au tribunal reste à confirmer.") {
    super(message);
    this.name = "TribunalCourtUnresolvedError";
  }
}

export const TRIBUNAL_JUDICIAL_ACTIVITY_BUILDER_VERSION = "tribunal_judicial_activity_v3" as const;
export const TRIBUNAL_JUDICIAL_ACTIVITY_MIN_SAMPLE = TRIBUNAL_STATISTICS_RANGE_MIN_SAMPLE;

const isoDateTimeSchema = z.string().check(z.iso.datetime({ offset: true }));
// Entier positif ou nul ; entier strictement positif ; part entre 0 et 1 ; libellé non vide.
const countSchema = () => z.number().check(z.int(), z.nonnegative());
const positiveCountSchema = () => z.number().check(z.int(), z.positive());
const shareSchema = () => z.number().check(z.gte(0), z.lte(1));
const nonEmptyStringSchema = () => z.string().check(z.minLength(1));

export const tribunalJudicialActivityHistoryMonthsSchema = z.union([
  z.literal(3),
  z.literal(12),
  z.literal(24),
  z.literal(36),
]);

export const tribunalJudicialActivityQuerySchema = z
  .strictObject({
    courtCode: z.optional(
      z
        .pipe(
          z.string().check(z.trim(), z.minLength(1), z.maxLength(80)),
          z.transform((value: string) => value.toLocaleLowerCase("fr-FR")),
        )
        .check(
          z.refine((value) => /^[a-z0-9][a-z0-9:._-]*$/.test(value), {
            message: "Code tribunal invalide.",
          }),
        ),
    ),
    saleId: z.optional(z.string().check(z.guid())),
    // `z.preprocess(fn, schema)` de zod est le tuyau `transform(fn)` puis `schema`.
    historyMonths: z.pipe(
      z.transform((value: unknown) => (value === undefined ? 36 : Number(value))),
      tribunalJudicialActivityHistoryMonthsSchema,
    ),
  })
  .check(
    z.refine((value) => Boolean(value.courtCode) !== Boolean(value.saleId), {
      message: "Fournissez exactement courtCode ou saleId.",
    }),
  );

const publishedMetricSchema = z.strictObject({
  status: z.literal("published"),
  value: z.number().check(z.nonnegative()),
  sampleSize: countSchema(),
});

const suppressedMetricSchema = z.strictObject({
  status: z.literal("insufficient_data"),
  value: z.null(),
  sampleSize: countSchema(),
});

export const tribunalJudicialActivityMetricSchema = z.discriminatedUnion("status", [
  publishedMetricSchema,
  suppressedMetricSchema,
]);

const publishedRangeMetricSchema = z
  .strictObject({
    status: z.literal("published"),
    p25: z.number().check(z.nonnegative()),
    p50: z.number().check(z.nonnegative()),
    p75: z.number().check(z.nonnegative()),
    sampleSize: countSchema(),
  })
  .check(
    z.superRefine((metric, context) => {
      if (metric.p25 > metric.p50 || metric.p50 > metric.p75) {
        context.addIssue({
          code: "custom",
          message: "Les quantiles doivent être monotones (P25 ≤ P50 ≤ P75).",
        });
      }
    }),
  );

const suppressedRangeMetricSchema = z.strictObject({
  status: z.literal("insufficient_data"),
  p25: z.null(),
  p50: z.null(),
  p75: z.null(),
  sampleSize: countSchema(),
});

export const tribunalJudicialActivityRangeMetricSchema = z.union([
  publishedRangeMetricSchema,
  suppressedRangeMetricSchema,
]);

const propertyTypeShareSchema = z.strictObject({
  propertyType: nonEmptyStringSchema(),
  count: positiveCountSchema(),
  share: shareSchema(),
});

const propertyTypeBenchmarkSchema = z.strictObject({
  propertyType: nonEmptyStringSchema(),
  observedSales: positiveCountSchema(),
  startingPriceRangeEur: tribunalJudicialActivityRangeMetricSchema,
  discoveryLeadRangeDays: tribunalJudicialActivityRangeMetricSchema,
});

const upcomingPropertyTypeBenchmarkSchema = z.strictObject({
  propertyType: nonEmptyStringSchema(),
  upcomingSales: positiveCountSchema(),
  startingPriceRangeEur: tribunalJudicialActivityRangeMetricSchema,
  discoveryLeadRangeDays: tribunalJudicialActivityRangeMetricSchema,
});

const occupationDistributionSchema = z.strictObject({
  status: z.enum(["vacant", "occupied", "rented"]),
  count: countSchema(),
  share: shareSchema(),
});

const occupationSchema = z
  .strictObject({
    knownSales: countSchema(),
    unknownSales: countSchema(),
    distribution: z.array(occupationDistributionSchema).check(z.maxLength(3)),
  })
  .check(
    z.superRefine((occupation, context) => {
      const statuses = new Set<string>();
      let countTotal = 0;
      let shareTotal = 0;
      for (const [index, item] of occupation.distribution.entries()) {
        if (statuses.has(item.status)) {
          context.addIssue({
            code: "custom",
            path: ["distribution", index, "status"],
            message: "Chaque statut d’occupation ne peut apparaître qu’une fois.",
          });
        }
        statuses.add(item.status);
        countTotal += item.count;
        shareTotal += item.share;
        const expectedShare = occupation.knownSales === 0 ? 0 : item.count / occupation.knownSales;
        if (Math.abs(item.share - expectedShare) > 0.000001) {
          context.addIssue({
            code: "custom",
            path: ["distribution", index, "share"],
            message: "La part d’occupation doit utiliser le dénominateur des ventes renseignées.",
          });
        }
      }
      if (countTotal !== occupation.knownSales) {
        context.addIssue({
          code: "custom",
          path: ["distribution"],
          message: "Les effectifs d’occupation doivent totaliser les ventes renseignées.",
        });
      }
      const expectedShareTotal = occupation.knownSales === 0 ? 0 : 1;
      // Shares are serialized to six decimals by the builder. Three thirds
      // therefore sum to 0.999999, while each individual share still has to be
      // accurate to one millionth of its count denominator.
      if (Math.abs(shareTotal - expectedShareTotal) > 0.000003) {
        context.addIssue({
          code: "custom",
          path: ["distribution"],
          message: "Les parts d’occupation doivent totaliser 100 % des ventes renseignées.",
        });
      }
    }),
  );

const hearingCalendarEntrySchema = z.strictObject({
  date: z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/)),
  sales: positiveCountSchema(),
});

const communeShareSchema = z.strictObject({
  city: nonEmptyStringSchema(),
  count: positiveCountSchema(),
  share: shareSchema(),
});

export const tribunalJudicialActivityResponseSchema = z
  .strictObject({
    court: z.strictObject({
      code: nonEmptyStringSchema(),
      name: nonEmptyStringSchema(),
      judicialRegion: z.nullable(nonEmptyStringSchema()),
    }),
    period: z.strictObject({
      historyMonths: tribunalJudicialActivityHistoryMonthsSchema,
      historyStart: isoDateTimeSchema,
      asOf: isoDateTimeSchema,
      upcomingEnd: isoDateTimeSchema,
    }),
    activity: z.strictObject({
      observedPastSales: countSchema(),
      upcomingSales: countSchema(),
      upcomingSales90Days: countSchema(),
      upcomingHearingDays: countSchema(),
      nextSaleAt: z.nullable(isoDateTimeSchema),
      medianStartingPriceEur: tribunalJudicialActivityMetricSchema,
      startingPriceRangeEur: tribunalJudicialActivityRangeMetricSchema,
      upcomingMedianStartingPriceEur: tribunalJudicialActivityMetricSchema,
      upcomingStartingPriceRangeEur: tribunalJudicialActivityRangeMetricSchema,
      visitCoverage: tribunalJudicialActivityMetricSchema,
      observedVisitCoverage: z.optional(tribunalJudicialActivityMetricSchema),
      occupation: z.optional(occupationSchema),
      hearingCalendar: z.optional(z.array(hearingCalendarEntrySchema).check(z.maxLength(100))),
      communes: z.optional(z.array(communeShareSchema).check(z.maxLength(20))),
      medianDiscoveryLeadDays: tribunalJudicialActivityMetricSchema,
      discoveryLeadRangeDays: tribunalJudicialActivityRangeMetricSchema,
      upcomingMedianDiscoveryLeadDays: tribunalJudicialActivityMetricSchema,
      upcomingDiscoveryLeadRangeDays: tribunalJudicialActivityRangeMetricSchema,
      medianLotsPerHearingDay: tribunalJudicialActivityMetricSchema,
      medianDaysBetweenHearingDays: tribunalJudicialActivityMetricSchema,
      topPropertyTypes: z.array(propertyTypeShareSchema).check(z.maxLength(3)),
      upcomingTopPropertyTypes: z.array(propertyTypeShareSchema).check(z.maxLength(3)),
      propertyTypeBenchmarks: z.array(propertyTypeBenchmarkSchema).check(z.maxLength(12)),
      upcomingPropertyTypeBenchmarks: z
        .array(upcomingPropertyTypeBenchmarkSchema)
        .check(z.maxLength(12)),
    }),
    reliability: z.strictObject({
      level: z.enum(["insufficient_data", "indicative", "descriptive", "strong"]),
      label: nonEmptyStringSchema(),
      currentSampleSize: countSchema(),
      exactCourtMatch: z.literal(true),
      limitations: z.array(nonEmptyStringSchema()).check(z.minLength(1)),
    }),
    provenance: z.strictObject({
      builderVersion: z.literal(TRIBUNAL_JUDICIAL_ACTIVITY_BUILDER_VERSION),
      generatedAt: isoDateTimeSchema,
      courtReferenceSource: z.literal("justice_open_data"),
      includedVerificationStatuses: z.tuple([z.literal("verified"), z.literal("cross_checked")]),
      excludedPendingOrConflictingSales: z.literal(true),
      // Past hearings come from live catalogue rows and from the Outcome
      // Graph archive of purged announcements (verification status and
      // visit dates are not kept in the archive).
      historySources: z.tuple([z.literal("catalogue"), z.literal("outcome_graph_archive")]),
      archivedPastSales: countSchema(),
      mergedDuplicateAnnouncements: countSchema(),
    }),
  })
  .check(
    z.superRefine((response, context) => {
      const occupation = response.activity.occupation;
      if (!occupation) return;
      if (occupation.knownSales + occupation.unknownSales !== response.activity.observedPastSales) {
        context.addIssue({
          code: "custom",
          path: ["activity", "occupation"],
          message: "Les ventes renseignées et inconnues doivent couvrir l’historique observé.",
        });
      }
    }),
  );

export type TribunalJudicialActivityHistoryMonths = z.infer<
  typeof tribunalJudicialActivityHistoryMonthsSchema
>;
export type TribunalJudicialActivityQuery = z.infer<typeof tribunalJudicialActivityQuerySchema>;
export type TribunalJudicialActivityMetric = z.infer<typeof tribunalJudicialActivityMetricSchema>;
export type TribunalJudicialActivityRangeMetric = z.infer<
  typeof tribunalJudicialActivityRangeMetricSchema
>;
export type TribunalJudicialActivityResponse = z.infer<
  typeof tribunalJudicialActivityResponseSchema
>;

export type TribunalJudicialActivityCourt = {
  code: string;
  name: string;
  judicialRegion: string | null;
};

export type TribunalJudicialActivitySale = {
  id: string;
  saleDate: string;
  status: string;
  startingPriceEur: number | null;
  propertyType: string | null;
  visitDates: unknown;
  firstSeenAt: string | null;
  occupationStatus?: string | null;
  city?: string | null;
  /** Court of the row; defaults to the profile court. Used to merge duplicates. */
  courtCode?: string | null;
  /** False when the row cannot tell whether a visit was announced (archive). */
  visitDatesKnown?: boolean;
  historySource?: "catalogue" | "outcome_graph_archive";
};

type ParsedTribunalJudicialActivitySale = TribunalJudicialActivitySale & {
  parsedSaleDate: Date;
};

export function judicialActivityPeriod(
  asOf: Date,
  historyMonths: TribunalJudicialActivityHistoryMonths,
): { historyStart: Date; upcomingEnd: Date } {
  assertValidDate(asOf, "asOf");
  return {
    historyStart:
      historyMonths === 3
        ? addUtcCalendarMonths(asOf, -3)
        : new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - historyMonths, 1)),
    upcomingEnd: addUtcCalendarMonths(asOf, 12),
  };
}

export function buildTribunalJudicialActivity(input: {
  court: TribunalJudicialActivityCourt;
  sales: TribunalJudicialActivitySale[];
  asOf: Date;
  historyMonths: TribunalJudicialActivityHistoryMonths;
}): TribunalJudicialActivityResponse {
  const { court, asOf, historyMonths } = input;
  const { historyStart, upcomingEnd } = judicialActivityPeriod(asOf, historyMonths);
  const upcoming90End = new Date(asOf.getTime() + 90 * 24 * 60 * 60 * 1_000);
  const seenIds = new Set<string>();
  const inWindow: ParsedTribunalJudicialActivitySale[] = [];
  const past: ParsedTribunalJudicialActivitySale[] = [];
  const upcoming: ParsedTribunalJudicialActivitySale[] = [];

  for (const sale of input.sales) {
    if (seenIds.has(sale.id)) throw new Error("Duplicate sale in judicial activity input.");
    seenIds.add(sale.id);
    const parsedSaleDate = new Date(sale.saleDate);
    if (!Number.isFinite(parsedSaleDate.getTime())) continue;
    const isPast =
      parsedSaleDate >= historyStart &&
      parsedSaleDate < asOf &&
      (sale.status === "past" || sale.status === "adjudicated");
    const isUpcoming =
      parsedSaleDate >= asOf && parsedSaleDate < upcomingEnd && sale.status === "upcoming";
    if (isPast || isUpcoming) inWindow.push({ ...sale, parsedSaleDate });
  }
  // The same lot published by several sources is one hearing, not several.
  const merged = mergeDuplicateJudicialAnnouncements(inWindow, court.code);
  for (const sale of merged.sales) {
    if (sale.status === "upcoming") upcoming.push(sale);
    else past.push(sale);
  }

  upcoming.sort(
    (left, right) =>
      left.parsedSaleDate.getTime() - right.parsedSaleDate.getTime() ||
      left.id.localeCompare(right.id),
  );
  const observedPrices = startingPrices(past);
  const upcomingPrices = startingPrices(upcoming);
  const observedLeadDays = discoveryLeadDays(past);
  const upcomingLeadDays = discoveryLeadDays(upcoming);
  const visits = upcoming.filter((sale) => hasVisitDate(sale.visitDates)).length;
  // Archived hearings do not keep visit dates: they are left out of the
  // denominator instead of being counted as "no visit announced".
  const pastWithVisitInformation = past.filter((sale) => sale.visitDatesKnown !== false);
  const observedVisits = pastWithVisitInformation.filter((sale) =>
    hasVisitDate(sale.visitDates),
  ).length;
  const hearingDayCounts = new Map<string, number>();
  for (const sale of upcoming) {
    const day = parisDayKey(sale.parsedSaleDate);
    hearingDayCounts.set(day, (hearingDayCounts.get(day) ?? 0) + 1);
  }
  const hearingDays = [...hearingDayCounts.keys()].sort();
  const hearingDayIntervals = hearingDays.slice(1).map((day, index) => {
    const previous = hearingDays[index]!;
    return (
      (Date.parse(`${day}T12:00:00.000Z`) - Date.parse(`${previous}T12:00:00.000Z`)) /
      (24 * 60 * 60 * 1_000)
    );
  });
  const hearingCalendar = buildHearingCalendar(upcoming, upcoming90End);

  const response: TribunalJudicialActivityResponse = {
    court,
    period: {
      historyMonths,
      historyStart: historyStart.toISOString(),
      asOf: asOf.toISOString(),
      upcomingEnd: upcomingEnd.toISOString(),
    },
    activity: {
      observedPastSales: past.length,
      upcomingSales: upcoming.length,
      upcomingSales90Days: upcoming.filter((sale) => sale.parsedSaleDate < upcoming90End).length,
      upcomingHearingDays: hearingDayCounts.size,
      nextSaleAt: upcoming[0]?.parsedSaleDate.toISOString() ?? null,
      // Existing price and lead fields are deliberately historical-only. This
      // keeps existing consumers from presenting future pipeline rows as
      // observed history.
      medianStartingPriceEur: sampleMetric(observedPrices, median(observedPrices)),
      startingPriceRangeEur: rangeMetric(observedPrices),
      upcomingMedianStartingPriceEur: sampleMetric(upcomingPrices, median(upcomingPrices)),
      upcomingStartingPriceRangeEur: rangeMetric(upcomingPrices),
      visitCoverage: sampleMetric(upcoming, upcoming.length > 0 ? visits / upcoming.length : null),
      observedVisitCoverage: sampleMetric(
        pastWithVisitInformation,
        pastWithVisitInformation.length > 0
          ? observedVisits / pastWithVisitInformation.length
          : null,
      ),
      occupation: occupationStats(past),
      hearingCalendar,
      communes: observedCommunes(past),
      medianDiscoveryLeadDays: sampleMetric(observedLeadDays, median(observedLeadDays)),
      discoveryLeadRangeDays: rangeMetric(observedLeadDays),
      upcomingMedianDiscoveryLeadDays: sampleMetric(upcomingLeadDays, median(upcomingLeadDays)),
      upcomingDiscoveryLeadRangeDays: rangeMetric(upcomingLeadDays),
      medianLotsPerHearingDay: sampleMetric(
        [...hearingDayCounts.values()],
        median([...hearingDayCounts.values()]),
        3,
      ),
      medianDaysBetweenHearingDays: sampleMetric(
        hearingDayIntervals,
        median(hearingDayIntervals),
        3,
      ),
      topPropertyTypes: topPropertyTypes(past),
      upcomingTopPropertyTypes: topPropertyTypes(upcoming),
      propertyTypeBenchmarks: observedPropertyTypeBenchmarks(past),
      upcomingPropertyTypeBenchmarks: upcomingPropertyTypeBenchmarks(upcoming),
    },
    reliability: {
      ...reliability(past.length),
      currentSampleSize: past.length,
      exactCourtMatch: true,
      limitations: [
        "Comptage des annonces judiciaires suivies par Immojudis, sans garantie d’exhaustivité nationale.",
        "Les annonces en attente, conflictuelles, sans date plausible ou sans tribunal exactement rattaché sont exclues.",
        "L’historique réunit les audiences passées encore au catalogue et celles archivées dans le graphe des résultats après le retrait de l’annonce ; l’archive ne conserve ni le statut de vérification ni les dates de visite.",
        "Une même vente publiée par plusieurs sources (même tribunal, même jour d’audience, même mise à prix, même commune) n’est comptée qu’une fois.",
        "Les indicateurs historiques utilisent uniquement les audiences passées; le pipeline à venir est présenté séparément. Une audience passée ne prouve pas que le bien a été vendu.",
        "Les taux d’adjudication, de surenchère et les prix finaux restent masqués sans résultats contrôlés suffisants.",
      ],
    },
    provenance: {
      builderVersion: TRIBUNAL_JUDICIAL_ACTIVITY_BUILDER_VERSION,
      generatedAt: asOf.toISOString(),
      courtReferenceSource: "justice_open_data",
      includedVerificationStatuses: ["verified", "cross_checked"],
      excludedPendingOrConflictingSales: true,
      historySources: ["catalogue", "outcome_graph_archive"],
      archivedPastSales: past.filter((sale) => sale.historySource === "outcome_graph_archive")
        .length,
      mergedDuplicateAnnouncements: merged.mergedDuplicates,
    },
  };
  return tribunalJudicialActivityResponseSchema.parse(response);
}

function occupationStats(sales: ParsedTribunalJudicialActivitySale[]) {
  const statuses = ["vacant", "occupied", "rented"] as const;
  const counts = new Map<(typeof statuses)[number], number>(statuses.map((status) => [status, 0]));
  let knownSales = 0;
  for (const sale of sales) {
    const status = normalizeOccupationStatus(sale.occupationStatus);
    if (!status) continue;
    counts.set(status, (counts.get(status) ?? 0) + 1);
    knownSales += 1;
  }
  return {
    knownSales,
    unknownSales: sales.length - knownSales,
    distribution: statuses
      .map((status) => ({
        status,
        count: counts.get(status) ?? 0,
        share: knownSales > 0 ? round((counts.get(status) ?? 0) / knownSales, 6) : 0,
      }))
      .filter((entry) => entry.count > 0),
  };
}

function normalizeOccupationStatus(
  value: string | null | undefined,
): "vacant" | "occupied" | "rented" | null {
  const normalized = value?.trim().toLocaleLowerCase("fr-FR");
  if (normalized === "vacant" || normalized === "rented") return normalized;
  // Outcome Graph vocabulary: tenant_occupied / occupied_other.
  if (normalized === "tenant_occupied") return "rented";
  if (
    normalized === "occupied" ||
    normalized === "owner_occupied" ||
    normalized === "occupied_other" ||
    normalized === "squatted"
  ) {
    return "occupied";
  }
  return null;
}

function hasVisitDate(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some((item) => typeof item === "string" && publishedVisitDay(item) !== null)
  );
}

function publishedVisitDay(value: string): string | null {
  const parsed = publishedDay(value);
  if (parsed) return parsed;
  const match = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(value.trim());
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day, 12));
  if (
    !Number.isFinite(candidate.getTime()) ||
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return null;
  }
  return candidate.toISOString().slice(0, 10);
}

function buildHearingCalendar(sales: ParsedTribunalJudicialActivitySale[], upcoming90End: Date) {
  const counts = new Map<string, number>();
  for (const sale of sales) {
    if (sale.parsedSaleDate >= upcoming90End) continue;
    const date = parisDayKey(sale.parsedSaleDate);
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, salesCount]) => ({ date, sales: salesCount }));
}

function observedCommunes(sales: ParsedTribunalJudicialActivitySale[]) {
  // "Marseille", "MARSEILLE" and "Marseille " are one commune: group by a
  // fingerprint and keep the first spelling seen.
  const counts = new Map<string, { city: string; count: number }>();
  for (const sale of sales) {
    const city = sale.city?.trim();
    if (!city) continue;
    const key = labelFingerprint(city);
    if (!key) continue;
    const current = counts.get(key);
    if (current) current.count += 1;
    else counts.set(key, { city, count: 1 });
  }
  const knownSales = [...counts.values()].reduce((total, entry) => total + entry.count, 0);
  if (knownSales === 0) return [];
  return [...counts.values()]
    .map((entry) => [entry.city, entry.count] as const)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "fr"))
    .slice(0, 20)
    .map(([city, count]) => ({
      city,
      count,
      // The denominator is the past sales with a non-empty commune. Missing
      // communes are deliberately excluded rather than presented as a city.
      share: round(count / knownSales, 6),
    }));
}

function startingPrices(sales: ParsedTribunalJudicialActivitySale[]): number[] {
  return sales
    .map((sale) => sale.startingPriceEur)
    .filter((value): value is number => value != null && Number.isFinite(value) && value > 0);
}

function discoveryLeadDays(sales: ParsedTribunalJudicialActivitySale[]): number[] {
  return sales.flatMap((sale) => {
    if (!sale.firstSeenAt) return [];
    const firstSeen = new Date(sale.firstSeenAt);
    if (!Number.isFinite(firstSeen.getTime())) return [];
    const days = (sale.parsedSaleDate.getTime() - firstSeen.getTime()) / (24 * 60 * 60 * 1_000);
    return days >= 0 && days <= 365 ? [days] : [];
  });
}

function propertyTypeSales(
  sales: ParsedTribunalJudicialActivitySale[],
): Map<string, ParsedTribunalJudicialActivitySale[]> {
  const grouped = new Map<string, ParsedTribunalJudicialActivitySale[]>();
  for (const sale of sales) {
    // An unknown type is not "other": it is left out of type breakdowns.
    const propertyType = sale.propertyType?.trim().toLocaleLowerCase("fr-FR");
    if (!propertyType || propertyType === "unknown") continue;
    const existing = grouped.get(propertyType);
    if (existing) existing.push(sale);
    else grouped.set(propertyType, [sale]);
  }
  return grouped;
}

function topPropertyTypes(sales: ParsedTribunalJudicialActivitySale[]) {
  const grouped = propertyTypeSales(sales);
  // Shares use the sales whose type is known as denominator.
  const knownSales = [...grouped.values()].reduce((total, group) => total + group.length, 0);
  if (knownSales < TRIBUNAL_JUDICIAL_ACTIVITY_MIN_SAMPLE) return [];
  return [...grouped.entries()]
    .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
    .slice(0, 3)
    .map(([propertyType, groupedSales]) => ({
      propertyType,
      count: groupedSales.length,
      share: round(groupedSales.length / knownSales, 6),
    }));
}

function observedPropertyTypeBenchmarks(sales: ParsedTribunalJudicialActivitySale[]) {
  return [...propertyTypeSales(sales).entries()]
    .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
    .slice(0, 12)
    .map(([propertyType, groupedSales]) => ({
      propertyType,
      observedSales: groupedSales.length,
      startingPriceRangeEur: rangeMetric(startingPrices(groupedSales)),
      discoveryLeadRangeDays: rangeMetric(discoveryLeadDays(groupedSales)),
    }));
}

function upcomingPropertyTypeBenchmarks(sales: ParsedTribunalJudicialActivitySale[]) {
  return [...propertyTypeSales(sales).entries()]
    .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
    .slice(0, 12)
    .map(([propertyType, groupedSales]) => ({
      propertyType,
      upcomingSales: groupedSales.length,
      startingPriceRangeEur: rangeMetric(startingPrices(groupedSales)),
      discoveryLeadRangeDays: rangeMetric(discoveryLeadDays(groupedSales)),
    }));
}

function sampleMetric(
  sample: unknown[],
  value: number | null,
  minimum = TRIBUNAL_JUDICIAL_ACTIVITY_MIN_SAMPLE,
): TribunalJudicialActivityMetric {
  if (sample.length < minimum || value == null || !Number.isFinite(value)) {
    return { status: "insufficient_data", value: null, sampleSize: sample.length };
  }
  return { status: "published", value: round(value, 2), sampleSize: sample.length };
}

function rangeMetric(
  values: number[],
  minimum = TRIBUNAL_JUDICIAL_ACTIVITY_MIN_SAMPLE,
): TribunalJudicialActivityRangeMetric {
  const sample = values.filter((value) => Number.isFinite(value) && value >= 0);
  if (sample.length < minimum) {
    return {
      status: "insufficient_data",
      p25: null,
      p50: null,
      p75: null,
      sampleSize: sample.length,
    };
  }
  return {
    status: "published",
    p25: round(quantile(sample, 0.25)!, 2),
    p50: round(quantile(sample, 0.5)!, 2),
    p75: round(quantile(sample, 0.75)!, 2),
    sampleSize: sample.length,
  };
}

function median(values: number[]): number | null {
  return quantile(values, 0.5);
}

function quantile(values: number[], probability: number): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const position = (ordered.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = ordered[lowerIndex]!;
  const upper = ordered[upperIndex]!;
  return lower + (upper - lower) * (position - lowerIndex);
}

function reliability(sampleSize: number): {
  level: TribunalJudicialActivityResponse["reliability"]["level"];
  label: string;
} {
  if (sampleSize < 5) return { level: "insufficient_data", label: "Données insuffisantes" };
  if (sampleSize < 20) return { level: "indicative", label: "Activité indicative" };
  if (sampleSize < 50) return { level: "descriptive", label: "Activité descriptive" };
  return { level: "strong", label: "Échantillon étendu" };
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function assertValidDate(value: Date, label: string): void {
  if (!Number.isFinite(value.getTime())) throw new Error(`${label} must be a valid date.`);
}

function addUtcCalendarMonths(value: Date, months: number): Date {
  const targetMonthStart = new Date(
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
  const lastTargetDay = new Date(
    Date.UTC(targetMonthStart.getUTCFullYear(), targetMonthStart.getUTCMonth() + 1, 0),
  ).getUTCDate();
  targetMonthStart.setUTCDate(Math.min(value.getUTCDate(), lastTargetDay));
  return targetMonthStart;
}
