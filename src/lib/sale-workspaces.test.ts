import { describe, expect, it } from "vitest";
import {
  normalizeBooleanRecord,
  normalizeDocumentReviews,
  normalizeNotes,
  saleWorkspaceInputSchema,
} from "@/lib/sale-workspaces";
import { DEFAULT_DOCUMENT_REVIEW, DEFAULT_WORKSPACE_NOTES } from "@/lib/sale-workspace-shared";

describe("sale workspace helpers", () => {
  it("normalizes invalid notes to the default shape", () => {
    expect(normalizeNotes(null)).toEqual(DEFAULT_WORKSPACE_NOTES);
    expect(normalizeNotes({ general: "À appeler", privateMode: false })).toEqual({
      ...DEFAULT_WORKSPACE_NOTES,
      general: "À appeler",
      privateMode: false,
    });
  });

  it("keeps only boolean checklist values", () => {
    expect(
      normalizeBooleanRecord({
        "Relire le cahier": true,
        "Chiffrer les travaux": false,
        "Champ invalide": "oui",
      }),
    ).toEqual({
      "Relire le cahier": true,
      "Chiffrer les travaux": false,
    });
  });

  it("normalizes per-document reviews", () => {
    expect(
      normalizeDocumentReviews({
        "cahier:main": {
          status: "reviewed",
          note: "Occupation à confirmer",
          question: "Le lot est-il libre ?",
          priority: true,
          reviewedAt: "2026-07-06T08:30:00.000Z",
          documentLabel: "Cahier des conditions de vente",
          documentType: "cahier_conditions_vente",
          documentUrl: "https://example.test/cahier.pdf",
          readPages: {
            "cahier:main:4": true,
            invalid: "yes",
          },
          highlightedExcerpt: "Clause d'occupation",
        },
        "": {
          status: "reviewed",
        },
        invalid: {
          status: "unknown",
        },
      }),
    ).toEqual({
      "cahier:main": {
        ...DEFAULT_DOCUMENT_REVIEW,
        status: "reviewed",
        note: "Occupation à confirmer",
        question: "Le lot est-il libre ?",
        priority: true,
        reviewedAt: "2026-07-06T08:30:00.000Z",
        documentLabel: "Cahier des conditions de vente",
        documentType: "cahier_conditions_vente",
        documentUrl: "https://example.test/cahier.pdf",
        readPages: {
          "cahier:main:4": true,
        },
        highlightedExcerpt: "Clause d'occupation",
      },
    });
  });

  it("validates workspace input boundaries", () => {
    expect(() =>
      saleWorkspaceInputSchema.parse({
        saleId: "7d335032-e935-4550-9347-ed22b0f63449",
        userMaxBidEur: -1,
      }),
    ).toThrow();

    expect(
      saleWorkspaceInputSchema.parse({
        saleId: "7d335032-e935-4550-9347-ed22b0f63449",
        trackingStatus: "bidding",
        userMaxBidEur: 180_000,
        documentReviews: {
          "diagnostic:1": {
            status: "question",
            question: "Le DPE est-il à jour ?",
          },
        },
      }),
    ).toMatchObject({
      trackingStatus: "bidding",
      userMaxBidEur: 180_000,
      documentReviews: {
        "diagnostic:1": {
          status: "question",
          question: "Le DPE est-il à jour ?",
        },
      },
    });
  });

  it("keeps partial workspace payloads partial", () => {
    expect(
      saleWorkspaceInputSchema.parse({
        saleId: "7d335032-e935-4550-9347-ed22b0f63449",
        privateNotes: { general: "Appeler l'avocat" },
      }),
    ).not.toHaveProperty("trackingStatus");
  });
});
