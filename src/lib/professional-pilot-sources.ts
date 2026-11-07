/** Liens de pièces sûrs pour les fiches pilotes professionnelles. */
import { safeDocumentUrl } from "@/lib/documents";
import type { AuctionSale } from "@/lib/types";

export function firstSafeUrl(...values: unknown[]): string | null {
  for (const value of values) {
    const url = safeDocumentUrl(value);
    if (url) return url;
  }
  return null;
}

export function riskSource(sale: AuctionSale, pattern: RegExp): string | null {
  const occurrence = (sale.risks ?? [])
    .filter((risk) => pattern.test(`${risk.risk_type} ${risk.risk_label} ${risk.evidence ?? ""}`))
    .flatMap((risk) => risk.occurrences ?? [])
    .find((item) => safeDocumentUrl(item.document_url));
  return safeDocumentUrl(occurrence?.document_url);
}
