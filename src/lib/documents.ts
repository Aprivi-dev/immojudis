import type { SaleDocument } from "@/lib/types";

export function parseDocs(raw: unknown): SaleDocument[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((document): SaleDocument | null => {
        if (typeof document === "string") return { url: document };
        if (
          document &&
          typeof document === "object" &&
          "url" in document &&
          typeof (document as { url: unknown }).url === "string"
        ) {
          return document as SaleDocument;
        }
        return null;
      })
      .filter((document): document is SaleDocument => document !== null);
  }
  if (typeof raw === "object" && raw !== null) {
    return Object.values(raw as Record<string, unknown>)
      .filter((value): value is string => typeof value === "string")
      .map((url) => ({ url }));
  }
  return [];
}
