/** Liens de pièces sûrs pour les fiches pilotes professionnelles. */
import { safeDocumentUrl } from "@/lib/documents";

export function firstSafeUrl(...values: unknown[]): string | null {
  for (const value of values) {
    const url = safeDocumentUrl(value);
    if (url) return url;
  }
  return null;
}
