import "server-only";
import type { TribunalListingStatisticsSale } from "@/lib/tribunal-listing-statistics";

export type StoredListingSale = TribunalListingStatisticsSale & {
  tribunal: string | null;
  sourceUrl: string | null;
  externalId: string | null;
  contentHash: string | null;
  identityAddress: string | null;
  legalReference: string | null;
  lotNumber: string | null;
  valuationSource: Record<string, unknown>;
};

export function normalizeLabel(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr-FR")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function normalizeLegalReference(value: string | null): string | null {
  if (!value) return null;
  const match = /^\s*(\d{1,4})\s*\/\s*(\d{1,8})\s*$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const serial = Number(match[2]);
  if (!Number.isSafeInteger(year) || !Number.isSafeInteger(serial) || serial <= 0) return null;
  return `${year}/${serial}`;
}

export function positive(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value > 0;
}
