import { hearingIdentityKey } from "@/lib/tribunal-hearing-identity";
import type { TribunalJudicialActivitySale } from "@/lib/tribunal-judicial-activity";

type ParsedSale = TribunalJudicialActivitySale & { parsedSaleDate: Date };

/**
 * Merge announcements of the same lot (see tribunal-hearing-identity.ts) so a
 * hearing counts once in every count, median and quantile.
 *
 * The representative is a live catalogue row when one exists (it carries the
 * visit dates and the publication filters), then the earliest detection. The
 * merged row keeps the earliest first detection of the lot across sources,
 * the first known occupation, property type and visit information.
 */
export function mergeDuplicateJudicialAnnouncements<T extends ParsedSale>(
  sales: T[],
  fallbackCourtCode: string,
): { sales: T[]; mergedDuplicates: number } {
  const groups = new Map<string, T[]>();
  const unique: T[] = [];
  for (const sale of sales) {
    const bucket = statusBucket(sale.status);
    const key = bucket
      ? hearingIdentityKey({
          courtCode: sale.courtCode ?? fallbackCourtCode,
          saleAt: sale.parsedSaleDate,
          startingPriceEur: sale.startingPriceEur,
          city: sale.city,
        })
      : null;
    if (!key) {
      unique.push(sale);
      continue;
    }
    const groupKey = `${bucket}|${key}`;
    const group = groups.get(groupKey);
    if (group) group.push(sale);
    else groups.set(groupKey, [sale]);
  }

  let mergedDuplicates = 0;
  for (const group of groups.values()) {
    mergedDuplicates += group.length - 1;
    unique.push(group.length === 1 ? group[0]! : mergeGroup(group));
  }
  return { sales: unique, mergedDuplicates };
}

function mergeGroup<T extends ParsedSale>(group: T[]): T {
  const ordered = [...group].sort(
    (left, right) =>
      Number(right.visitDatesKnown !== false) - Number(left.visitDatesKnown !== false) ||
      timeOrInfinity(left.firstSeenAt) - timeOrInfinity(right.firstSeenAt) ||
      left.id.localeCompare(right.id),
  );
  const representative = ordered[0]!;
  const earliestFirstSeen = ordered
    .map((sale) => sale.firstSeenAt)
    .filter((value): value is string => Boolean(value) && Number.isFinite(Date.parse(value!)))
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
  const visitSource = ordered.find(
    (sale) =>
      sale.visitDatesKnown !== false && Array.isArray(sale.visitDates) && sale.visitDates.length,
  );
  return {
    ...representative,
    firstSeenAt: earliestFirstSeen ?? representative.firstSeenAt,
    visitDates: visitSource?.visitDates ?? representative.visitDates,
    visitDatesKnown: ordered.some((sale) => sale.visitDatesKnown !== false),
    propertyType:
      ordered
        .map((sale) => sale.propertyType?.trim())
        .find((value) => value && value !== "unknown") ?? representative.propertyType,
    occupationStatus:
      ordered
        .map((sale) => sale.occupationStatus?.trim())
        .find((value) => value && value !== "unknown") ?? representative.occupationStatus,
    historySource: ordered.some((sale) => sale.historySource !== "outcome_graph_archive")
      ? "catalogue"
      : "outcome_graph_archive",
  };
}

function statusBucket(status: string): "past" | "upcoming" | null {
  if (status === "past" || status === "adjudicated") return "past";
  if (status === "upcoming") return "upcoming";
  return null;
}

function timeOrInfinity(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}
