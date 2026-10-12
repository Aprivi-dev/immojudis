import "server-only";
import { hearingIdentityKey } from "@/lib/tribunal-hearing-identity";
import type { TribunalListingStatisticsSale } from "@/lib/tribunal-listing-statistics";
import type { ArchivedHearing } from "@/lib/tribunal-outcome-graph-history";

/**
 * Turn archived Outcome Graph hearings into listing-statistics rows.
 *
 * Archived rows are announcements purged from the catalogue after their
 * hearing. They never replace a live catalogue row: an archived hearing whose
 * lot identity (court, Paris hearing day, starting price, commune) matches a
 * live row is dropped, and archived copies of one lot from several sources
 * are merged into one row keeping the earliest detection.
 */
export function archivedListingSales(input: {
  hearings: ArchivedHearing[];
  liveSales: Array<Pick<TribunalListingStatisticsSale, "saleDate" | "startingPriceEur" | "city">>;
  courtCode: string;
}): { sales: TribunalListingStatisticsSale[]; mergedDuplicates: number } {
  const liveKeys = new Set<string>();
  for (const sale of input.liveSales) {
    const saleAt = sale.saleDate ? new Date(sale.saleDate) : null;
    if (!saleAt) continue;
    const key = hearingIdentityKey({
      courtCode: input.courtCode,
      saleAt,
      startingPriceEur: sale.startingPriceEur,
      city: sale.city,
    });
    if (key) liveKeys.add(key);
  }

  const groups = new Map<string, ArchivedHearing[]>();
  const singles: ArchivedHearing[] = [];
  let mergedDuplicates = 0;
  for (const hearing of input.hearings) {
    const key = hearingIdentityKey({
      courtCode: hearing.courtCode,
      saleAt: new Date(hearing.scheduledAt),
      startingPriceEur: hearing.startingPriceEur,
      city: hearing.city,
    });
    if (!key) {
      singles.push(hearing);
      continue;
    }
    if (liveKeys.has(key)) {
      mergedDuplicates += 1;
      continue;
    }
    const group = groups.get(key);
    if (group) group.push(hearing);
    else groups.set(key, [hearing]);
  }

  const sales = singles.map((hearing) => listingSale([hearing]));
  for (const group of groups.values()) {
    mergedDuplicates += group.length - 1;
    sales.push(listingSale(group));
  }
  return { sales, mergedDuplicates };
}

function listingSale(group: ArchivedHearing[]): TribunalListingStatisticsSale {
  const ordered = [...group].sort(
    (left, right) =>
      timeOrInfinity(left.firstSeenAt) - timeOrInfinity(right.firstSeenAt) ||
      left.roundId.localeCompare(right.roundId),
  );
  const representative = ordered[0]!;
  const sourceNames = [...new Set(ordered.map((hearing) => hearing.sourceName))].sort((a, b) =>
    a.localeCompare(b, "fr"),
  );
  return {
    id: representative.roundId,
    title: representative.lotLabel,
    city: representative.city,
    address: null,
    sourceName: representative.sourceName,
    sourceNames,
    sourceUrls: ordered
      .map((hearing) => hearing.sourceUrl)
      .filter((value): value is string => Boolean(value)),
    saleDate: representative.scheduledAt,
    status: "past",
    startingPriceEur: representative.startingPriceEur,
    propertyType: ordered.find((hearing) => hearing.propertyType)?.propertyType ?? null,
    visitDates: [],
    visitInformationAvailable: false,
    occupancyStatus: ordered.find((hearing) => hearing.occupancyStatus)?.occupancyStatus ?? null,
    lawyerName: ordered.find((hearing) => hearing.lawyerLabel)?.lawyerLabel ?? null,
    // No trusted source publication date survives in the archive: the
    // earliest detection is used and reported under discoveryDatesUsed.
    publicationAt: null,
    firstSeenAt: representative.firstSeenAt,
    overbidStatus: null,
    overbidEvidence: [],
    marketEstimate: null,
    marketEstimateEligible: false,
    historySource: "outcome_graph_archive",
  };
}

function timeOrInfinity(value: string | null): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}
