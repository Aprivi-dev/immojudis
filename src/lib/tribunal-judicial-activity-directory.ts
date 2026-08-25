import { z } from "zod";
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

const isoDateTimeSchema = z.string().datetime({ offset: true });
const DIRECTORY_VERSION = "tribunal_judicial_activity_directory_v2" as const;

const scopeCoverageSchema = z
  .object({
    trackedCourts: z.number().int().nonnegative(),
    publishableCourtProfiles: z.number().int().nonnegative(),
    rate: z.number().min(0).max(1),
  })
  .strict()
  .superRefine((coverage, context) => {
    if (coverage.publishableCourtProfiles > coverage.trackedCourts) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["publishableCourtProfiles"],
        message: "Le nombre de profils publiables ne peut pas dépasser les tribunaux suivis.",
      });
    }
    const expectedRate =
      coverage.trackedCourts === 0 ? 0 : coverage.publishableCourtProfiles / coverage.trackedCourts;
    if (Math.abs(coverage.rate - expectedRate) > 0.000001) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rate"],
        message: "Le taux de couverture doit correspondre aux profils publiables.",
      });
    }
  });

const scopeOverviewSchema = z
  .object({
    observedPastSales: z.number().int().nonnegative(),
    upcomingSales: z.number().int().nonnegative(),
    upcomingSales90Days: z.number().int().nonnegative(),
    startingPriceRangeEur: tribunalJudicialActivityRangeMetricSchema,
    discoveryLeadRangeDays: tribunalJudicialActivityRangeMetricSchema,
    visitCoverage: tribunalJudicialActivityMetricSchema,
    coverage: scopeCoverageSchema,
  })
  .strict();

export const tribunalJudicialActivityDirectoryQuerySchema = z
  .object({
    historyMonths: z.preprocess(
      (value) => (value === undefined ? 36 : Number(value)),
      tribunalJudicialActivityHistoryMonthsSchema,
    ),
  })
  .strict();

export const tribunalJudicialActivityDirectoryResponseSchema = z
  .object({
    period: z
      .object({
        historyMonths: tribunalJudicialActivityHistoryMonthsSchema,
        historyStart: isoDateTimeSchema,
        asOf: isoDateTimeSchema,
        upcomingEnd: isoDateTimeSchema,
      })
      .strict(),
    totals: z
      .object({
        trackedCourts: z.number().int().nonnegative(),
        observedPastSales: z.number().int().nonnegative(),
        upcomingSales: z.number().int().nonnegative(),
        upcomingSales90Days: z.number().int().nonnegative(),
      })
      .strict(),
    national: scopeOverviewSchema,
    regions: z
      .array(
        z
          .object({
            name: z.string().min(1),
            ...scopeOverviewSchema.shape,
          })
          .strict(),
      )
      .max(50),
    tribunals: z.array(tribunalJudicialActivityResponseSchema).max(250),
    provenance: z
      .object({
        generatedAt: isoDateTimeSchema,
        directoryVersion: z.literal(DIRECTORY_VERSION),
        includesOnlyExactActiveCourts: z.literal(true),
        aggregationOrder: z.literal("national_region_tribunal"),
      })
      .strict(),
  })
  .strict();

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
  for (const sale of input.sales) {
    const courtCode = sale.tribunalCode.toLocaleLowerCase("fr-FR");
    if (!courtByCode.has(courtCode)) continue;
    const existing = salesByCourt.get(courtCode);
    if (existing) existing.push(sale);
    else salesByCourt.set(courtCode, [sale]);
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
  tribunals.sort(
    (left, right) =>
      right.activity.upcomingSales - left.activity.upcomingSales ||
      left.court.name.localeCompare(right.court.name, "fr"),
  );

  const trackedCourtCodes = new Set(
    tribunals.map((tribunal) => tribunal.court.code.toLocaleLowerCase("fr-FR")),
  );
  const includedSales = input.sales.filter((sale) =>
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
        right.upcomingSales - left.upcomingSales || left.name.localeCompare(right.name, "fr"),
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
