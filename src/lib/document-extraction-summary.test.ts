import { describe, expect, it } from "vitest";
import { documentExtractionSummary } from "./document-extraction-summary";
import type { SaleDocumentRich } from "./types";

const document: SaleDocumentRich = {
  url: "https://example.com/diagnostic.pdf",
  label: "Diagnostic",
  type: "diagnostics_techniques",
  extraction_status: "pending",
};

describe("documentExtractionSummary", () => {
  it("keeps a large incomplete extraction partial", () => {
    expect(
      documentExtractionSummary({
        ...document,
        extraction_status: "incomplete",
        text_chars: 500_000,
      }),
    ).toContain("Extraction partielle");
  });

  it("does not certify facts or completeness from recovered text", () => {
    expect(
      documentExtractionSummary({ ...document, extraction_status: "extracted", text_chars: 1800 }),
    ).toBe("Texte récupéré · informations à vérifier dans la pièce originale.");
    expect(
      documentExtractionSummary({ ...document, extraction_status: "extracted", text_chars: 0 }),
    ).toContain("Extraction non renseignée");
  });

  it("distinguishes unavailable access, pending extraction and missing metadata", () => {
    expect(documentExtractionSummary({ ...document, download_status: "blocked" })).toContain(
      "Accès à la pièce indisponible",
    );
    expect(documentExtractionSummary(document)).toBe("Texte en attente d’extraction.");
    expect(documentExtractionSummary({ ...document, extraction_status: null })).toContain(
      "Extraction non renseignée",
    );
  });
});
