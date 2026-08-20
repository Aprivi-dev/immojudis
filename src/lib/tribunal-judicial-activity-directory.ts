import { z } from "zod";
import {
  buildTribunalJudicialActivity,
  judicialActivityPeriod,
  tribunalJudicialActivityHistoryMonthsSchema,
  tribunalJudicialActivityResponseSchema,
  type TribunalJudicialActivityCourt,
  type TribunalJudicialActivityHistoryMonths,
  type TribunalJudicialActivityResponse,
  type TribunalJudicialActivitySale,
} from "@/lib/tribunal-judicial-activity";

const isoDateTimeSchema = z.string().datetime({ offset: true });

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
    tribunals: z.array(tribunalJudicialActivityResponseSchema).max(250),
    provenance: z
      .object({
        generatedAt: isoDateTimeSchema,
        directoryVersion: z.literal("tribunal_judicial_activity_directory_v1"),
        includesOnlyExactActiveCourts: z.literal(true),
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
    tribunals,
    provenance: {
      generatedAt: input.asOf.toISOString(),
      directoryVersion: "tribunal_judicial_activity_directory_v1",
      includesOnlyExactActiveCourts: true,
    },
  };
  return tribunalJudicialActivityDirectoryResponseSchema.parse(response);
}
