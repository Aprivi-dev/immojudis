// zod/mini : la réponse de l'annuaire est validée dans le navigateur
// (`tribunal-judicial-activity-directory-client`). Mêmes règles que l'écriture chaînée de zod,
// avec bien moins de code envoyé au navigateur.
import { z } from "zod/mini";
import {
  buildTribunalJudicialActivity,
  judicialActivityPeriod,
  tribunalJudicialActivityMetricSchema,
  tribunalJudicialActivityHistoryMonthsSchema,
  tribunalJudicialActivityRangeMetricSchema,
  tribunalJudicialActivityResponseSchema,
  type TribunalJudicialActivityCourt,
  type TribunalJudicialActivityHistoryMonths,
  type TribunalJudicialActivityResponse,
  type TribunalJudicialActivitySale,
} from "@/lib/tribunal-judicial-activity";

const isoDateTimeSchema = z.string().check(z.iso.datetime({ offset: true }));
const DIRECTORY_VERSION = "tribunal_judicial_activity_directory_v2" as const;
// Entier positif ou nul.
const countSchema = () => z.number().check(z.int(), z.nonnegative());

const scopeCoverageSchema = z
  .strictObject({
    trackedCourts: countSchema(),
    publishableCourtProfiles: countSchema(),
    rate: z.number().check(z.gte(0), z.lte(1)),
  })
  .check(
    z.superRefine((coverage, context) => {
      if (coverage.publishableCourtProfiles > coverage.trackedCourts) {
        context.addIssue({
          code: "custom",
          path: ["publishableCourtProfiles"],
          message: "Le nombre de profils publiables ne peut pas dépasser les tribunaux suivis.",
        });
      }
      const expectedRate =
        coverage.trackedCourts === 0
          ? 0
          : coverage.publishableCourtProfiles / coverage.trackedCourts;
      if (Math.abs(coverage.rate - expectedRate) > 0.000001) {
        context.addIssue({
          code: "custom",
          path: ["rate"],
          message: "Le taux de couverture doit correspondre aux profils publiables.",
        });
      }
    }),
  );

const scopeOverviewSchema = z.strictObject({
  observedPastSales: countSchema(),
  upcomingSales: countSchema(),
  upcomingSales90Days: countSchema(),
  startingPriceRangeEur: tribunalJudicialActivityRangeMetricSchema,
  discoveryLeadRangeDays: tribunalJudicialActivityRangeMetricSchema,
  upcomingStartingPriceRangeEur: tribunalJudicialActivityRangeMetricSchema,
  upcomingDiscoveryLeadRangeDays: tribunalJudicialActivityRangeMetricSchema,
  visitCoverage: tribunalJudicialActivityMetricSchema,
  coverage: scopeCoverageSchema,
});

export const tribunalJudicialActivityDirectoryQuerySchema = z.strictObject({
  // `z.preprocess(fn, schema)` de zod est le tuyau `transform(fn)` puis `schema`.
  historyMonths: z.pipe(
    z.transform((value: unknown) => (value === undefined ? 36 : Number(value))),
    tribunalJudicialActivityHistoryMonthsSchema,
  ),
});

export const tribunalJudicialActivityDirectoryResponseSchema = z.strictObject({
  period: z.strictObject({
    historyMonths: tribunalJudicialActivityHistoryMonthsSchema,
    historyStart: isoDateTimeSchema,
    asOf: isoDateTimeSchema,
    upcomingEnd: isoDateTimeSchema,
  }),
  totals: z.strictObject({
    trackedCourts: countSchema(),
    observedPastSales: countSchema(),
    upcomingSales: countSchema(),
    upcomingSales90Days: countSchema(),
  }),
  national: scopeOverviewSchema,
  regions: z
    .array(
      z.strictObject({
        name: z.string().check(z.minLength(1)),
        ...scopeOverviewSchema.shape,
      }),
    )
    .check(z.maxLength(50)),
  tribunals: z.array(tribunalJudicialActivityResponseSchema).check(z.maxLength(250)),
  provenance: z.strictObject({
    generatedAt: isoDateTimeSchema,
    directoryVersion: z.literal(DIRECTORY_VERSION),
    includesOnlyExactActiveCourts: z.literal(true),
    aggregationOrder: z.literal("national_region_tribunal"),
  }),
});

export type TribunalJudicialActivityDirectoryQuery = z.infer<
  typeof tribunalJudicialActivityDirectoryQuerySchema
>;
export type TribunalJudicialActivityDirectoryResponse = z.infer<
  typeof tribunalJudicialActivityDirectoryResponseSchema
>;

export type TribunalJudicialActivityDirectorySale = TribunalJudicialActivitySale & {
  tribunalCode: string;
};

export function buildTribunalJudicialActivityDirectory(input: {
  courts: TribunalJudicialActivityCourt[];
  sales: TribunalJudicialActivityDirectorySale[];
  asOf: Date;
  historyMonths: TribunalJudicialActivityHistoryMonths;
}): TribunalJudicialActivityDirectoryResponse {
  const courtByCode = new Map(
    input.courts.map((court) => [court.code.toLocaleLowerCase("fr-FR"), court]),
  );
  const salesByCourt = new Map<string, TribunalJudicialActivitySale[]>();
  const courtSales: TribunalJudicialActivityDirectorySale[] = [];
  for (const sale of input.sales) {
    const courtCode = sale.tribunalCode.toLocaleLowerCase("fr-FR");
    if (!courtByCode.has(courtCode)) continue;
    // The court travels with the row so national and regional aggregates
    // never merge announcements of two different courts.
    const courtSale = { ...sale, courtCode };
    courtSales.push(courtSale);
    const existing = salesByCourt.get(courtCode);
    if (existing) existing.push(courtSale);
    else salesByCourt.set(courtCode, [courtSale]);
  }

  const tribunals: TribunalJudicialActivityResponse[] = [];
  for (const [courtCode, sales] of salesByCourt) {
    const court = courtByCode.get(courtCode);
    if (!court) continue;
    const activity = buildTribunalJudicialActivity({
      court,
      sales,
      asOf: input.asOf,
      historyMonths: input.historyMonths,
    });
    if (activity.activity.upcomingSales > 0 || activity.activity.observedPastSales > 0) {
      tribunals.push(activity);
    }
  }
  // Upcoming pipeline first, then observed history, then name: a court with
  // a rich history but no scheduled hearing is no longer ranked by name only.
  tribunals.sort(
    (left, right) =>
      right.activity.upcomingSales - left.activity.upcomingSales ||
      right.activity.observedPastSales - left.activity.observedPastSales ||
      left.court.name.localeCompare(right.court.name, "fr"),
  );

  const trackedCourtCodes = new Set(
    tribunals.map((tribunal) => tribunal.court.code.toLocaleLowerCase("fr-FR")),
  );
  const includedSales = courtSales.filter((sale) =>
    trackedCourtCodes.has(sale.tribunalCode.toLocaleLowerCase("fr-FR")),
  );
  const national = buildScopeOverview({
    name: "France entière",
    tribunals,
    sales: includedSales,
    asOf: input.asOf,
    historyMonths: input.historyMonths,
  });
  const tribunalsByRegion = new Map<string, TribunalJudicialActivityResponse[]>();
  for (const tribunal of tribunals) {
    const region = tribunal.court.judicialRegion?.trim();
    if (!region) continue;
    const existing = tribunalsByRegion.get(region);
    if (existing) existing.push(tribunal);
    else tribunalsByRegion.set(region, [tribunal]);
  }
  const regions = [...tribunalsByRegion.entries()]
    .map(([name, regionTribunals]) => {
      const regionCourtCodes = new Set(
        regionTribunals.map((tribunal) => tribunal.court.code.toLocaleLowerCase("fr-FR")),
      );
      return {
        name,
        ...buildScopeOverview({
          name,
          tribunals: regionTribunals,
          sales: includedSales.filter((sale) =>
            regionCourtCodes.has(sale.tribunalCode.toLocaleLowerCase("fr-FR")),
          ),
          asOf: input.asOf,
          historyMonths: input.historyMonths,
        }),
      };
    })
    .sort(
      (left, right) =>
        right.upcomingSales - left.upcomingSales ||
        right.observedPastSales - left.observedPastSales ||
        left.name.localeCompare(right.name, "fr"),
    );

  const { historyStart, upcomingEnd } = judicialActivityPeriod(input.asOf, input.historyMonths);
  const response: TribunalJudicialActivityDirectoryResponse = {
    period: {
      historyMonths: input.historyMonths,
      historyStart: historyStart.toISOString(),
      asOf: input.asOf.toISOString(),
      upcomingEnd: upcomingEnd.toISOString(),
    },
    totals: {
      trackedCourts: tribunals.length,
      observedPastSales: tribunals.reduce(
        (total, tribunal) => total + tribunal.activity.observedPastSales,
        0,
      ),
      upcomingSales: tribunals.reduce(
        (total, tribunal) => total + tribunal.activity.upcomingSales,
        0,
      ),
      upcomingSales90Days: tribunals.reduce(
        (total, tribunal) => total + tribunal.activity.upcomingSales90Days,
        0,
      ),
    },
    national,
    regions,
    tribunals,
    provenance: {
      generatedAt: input.asOf.toISOString(),
      directoryVersion: DIRECTORY_VERSION,
      includesOnlyExactActiveCourts: true,
      aggregationOrder: "national_region_tribunal",
    },
  };
  return tribunalJudicialActivityDirectoryResponseSchema.parse(response);
}

function buildScopeOverview(input: {
  name: string;
  tribunals: TribunalJudicialActivityResponse[];
  sales: TribunalJudicialActivitySale[];
  asOf: Date;
  historyMonths: TribunalJudicialActivityHistoryMonths;
}) {
  const aggregate = buildTribunalJudicialActivity({
    court: {
      code: `aggregate:${normalizeScopeKey(input.name)}`,
      name: input.name,
      judicialRegion: null,
    },
    sales: input.sales,
    asOf: input.asOf,
    historyMonths: input.historyMonths,
  });
  const publishableCourtProfiles = input.tribunals.filter(
    (tribunal) =>
      tribunal.activity.startingPriceRangeEur.status === "published" &&
      tribunal.activity.discoveryLeadRangeDays.status === "published",
  ).length;
  const trackedCourts = input.tribunals.length;

  return scopeOverviewSchema.parse({
    observedPastSales: aggregate.activity.observedPastSales,
    upcomingSales: aggregate.activity.upcomingSales,
    upcomingSales90Days: aggregate.activity.upcomingSales90Days,
    startingPriceRangeEur: aggregate.activity.startingPriceRangeEur,
    discoveryLeadRangeDays: aggregate.activity.discoveryLeadRangeDays,
    upcomingStartingPriceRangeEur: aggregate.activity.upcomingStartingPriceRangeEur,
    upcomingDiscoveryLeadRangeDays: aggregate.activity.upcomingDiscoveryLeadRangeDays,
    visitCoverage: aggregate.activity.visitCoverage,
    coverage: {
      trackedCourts,
      publishableCourtProfiles,
      rate: trackedCourts === 0 ? 0 : publishableCourtProfiles / trackedCourts,
    },
  });
}

function normalizeScopeKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr-FR")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
