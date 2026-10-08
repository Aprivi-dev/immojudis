import type { SaleDocumentRich } from "@/lib/types";

/** Text recovery is distinct from verification of the facts in a document. */
export function documentExtractionSummary(
  document: Pick<Partial<SaleDocumentRich>, "extraction_status" | "download_status" | "text_chars">,
): string {
  const status =
    typeof document.extraction_status === "string"
      ? document.extraction_status.toLowerCase()
      : null;
  const download =
    typeof document.download_status === "string" ? document.download_status.toLowerCase() : null;
  if (["blocked", "failed", "unavailable", "not_found"].includes(download ?? "")) {
    return "Récupération automatique indisponible · consulter la pièce originale.";
  }
  if (["incomplete", "partial", "ocr_failed"].includes(status ?? "")) {
    return "Extraction partielle · certaines pages restent à lire.";
  }
  if (
    status === "extracted" &&
    typeof document.text_chars === "number" &&
    Number.isFinite(document.text_chars) &&
    (document.text_chars ?? 0) > 0
  ) {
    return "Texte récupéré · informations à vérifier dans la pièce originale.";
  }
  if (["failed", "empty", "error"].includes(status ?? "")) {
    return "Texte non récupéré · consulter la pièce originale.";
  }
  if (status === "pending") return "Texte en attente d’extraction.";
  return "Extraction non renseignée · consulter la pièce originale.";
}
