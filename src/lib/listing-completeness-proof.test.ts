import { describe, expect, it } from "vitest";
import { EXAMPLE_SALE } from "./example-sale";
import { getListingCompleteness } from "./listing-completeness";
import type { AuctionSale, SaleDocumentRich } from "./types";

function listing(overrides: Partial<AuctionSale> = {}): AuctionSale {
  return {
    ...EXAMPLE_SALE,
    raw_payload: {},
    source_blocks: null,
    source_blocks_by_source: null,
    source_description: null,
    sale_procedure: null,
    documents: [],
    documents_rich: [],
    media: [],
    ...overrides,
  };
}

function proof(sale: AuctionSale) {
  return getListingCompleteness(sale).gates.find((gate) => gate.id === "source_proof")?.passed;
}

describe("readable source evidence for completeness", () => {
  it("does not let the generated checklist prove its own source capture", () => {
    const sale = listing({
      source_blocks: { listing_completeness: { source_field_observations: {} } },
    });
    expect(proof(sale)).toBe(false);
    expect(
      getListingCompleteness(sale).fields.find((field) => field.id === "source_blocks")?.state,
    ).toBe("unknown");
    expect(proof(listing({ source_blocks: { description: "Maison avec jardin." } }))).toBe(true);
  });

  it.each(["pending", "empty", "failed"])(
    "does not treat a %s PDF link as readable evidence",
    (status) => {
      const document: SaleDocumentRich = {
        url: "https://source.example/dossier.pdf",
        label: "Dossier",
        type: "pdf",
        extraction_status: status,
        text_chars: 0,
      };
      expect(proof(listing({ documents_rich: [document] }))).toBe(false);
      expect(
        proof(
          listing({
            documents_rich: [{ ...document, extraction_status: "extracted", text_chars: 900 }],
          }),
        ),
      ).toBe(true);
      expect(
        proof(
          listing({
            documents_rich: [
              {
                ...document,
                extraction_status: "extracted",
                text_chars: 900,
                download_status: "not_found",
              },
            ],
          }),
        ),
      ).toBe(false);
      expect(
        proof(
          listing({
            documents_rich: [{ ...document, extraction_status: "incomplete", text_chars: 900 }],
          }),
        ),
      ).toBe(true);
    },
  );

  it("requires an explicit observation before calling an image URL usable", () => {
    const result = getListingCompleteness(
      listing({
        raw_payload: { source_images: ["https://source.example/photo.jpg"] },
      }),
    );
    expect(result.fields.find((field) => field.id === "photos_count")?.value).toBe(1);
    expect(result.fields.find((field) => field.id === "photos_usable_count")?.state).toBe(
      "unknown",
    );
    expect(result.gates.find((gate) => gate.id === "source_proof")?.passed).toBe(false);
    expect(
      proof(
        listing({
          raw_payload: {
            source_field_observations: {
              photos_usable_count: {
                state: "observed",
                value: 1,
                evidence: [
                  {
                    grade: "A",
                    source_url: "https://source.example/photo.jpg",
                    locator: "photo-1",
                    excerpt: "Photo du bien contrôlée visuellement.",
                  },
                ],
              },
            },
          },
        }),
      ),
    ).toBe(true);
  });
});
