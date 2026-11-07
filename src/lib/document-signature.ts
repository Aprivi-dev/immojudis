import type { AuctionSale } from "@/lib/types";
/** Signature des pièces d'une vente, pour détecter leurs changements. */
export function primitiveDocumentValues(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(primitiveDocumentValues);
  if (typeof value === "object") return Object.values(value).flatMap(primitiveDocumentValues);
  return [];
}

export function documentSignatureParts(sale: AuctionSale): {
  count: number;
  signature: string | null;
} {
  const values = Array.isArray(sale.documents_rich)
    ? sale.documents_rich.map((document) =>
        [
          document.url,
          document.label,
          document.type ?? document.document_type,
          document.extraction_status,
        ]
          .filter(Boolean)
          .join("|"),
      )
    : primitiveDocumentValues(sale.documents);
  const unique = [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();

  return {
    count: unique.length,
    signature: unique.length ? unique.join("||") : null,
  };
}
