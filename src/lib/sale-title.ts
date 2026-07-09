import { propertyTypeLabel } from "@/lib/format";
import type { AuctionSale } from "@/lib/types";

const CEILING_TITLE_MENTION =
  /\s*(?:[:|·•-]|–|—)?\s*plafond\s+(?:conseill[eé]e?|recommand[eé]e?)(?:\s*(?:(?:à|a|de|:)\s*)?[0-9xX][0-9xX\s\u00a0\u202f.,]*(?:€|euros?|eur)?)?/gi;

export function cleanSaleTitle(title: string | null | undefined): string | null {
  if (!title) return null;

  const cleaned = title
    .replace(CEILING_TITLE_MENTION, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/^\s*(?:[:|·•-]|–|—)\s*/g, "")
    .replace(/\s*(?:[:|·•-]|–|—)\s*$/g, "")
    .trim();

  return cleaned || null;
}

export function saleDisplayTitle(
  sale: Pick<AuctionSale, "title" | "property_type">,
  fallback?: string,
): string {
  return cleanSaleTitle(sale.title) ?? fallback ?? propertyTypeLabel(sale.property_type);
}
