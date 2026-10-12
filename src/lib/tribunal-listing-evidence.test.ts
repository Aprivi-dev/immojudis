import { describe, expect, it } from "vitest";
import { extractTribunalListingEvidence } from "@/lib/tribunal-listing-evidence";

describe("extractTribunalListingEvidence", () => {
  it("extracts Licitor's explicit publication label and a filed overbid", () => {
    const result = extractTribunalListingEvidence(
      {
        raw_text:
          "Annonce publiée le 2 septembre 2026\nTribunal Judiciaire de Saint-Etienne\nUne surenchère a été déposée le 12 septembre 2026.",
        source_blocks: { page_text: "Vente aux enchères publiques" },
      },
      "licitor",
    );

    expect(result.publicationAt).toBe("2026-09-02T00:00:00.000Z");
    expect(result.publicationKind).toBe("source_explicit");
    expect(result.overbidStatus).toBe("filed");
    expect(result.overbidEvidence[0]).toMatch(/surenchère a été déposée/i);
  });

  it("extracts the Petites Affiches legal-notice date in numeric French format", () => {
    const result = extractTribunalListingEvidence(
      {
        source_blocks: {
          page_text: "Pub. légale : 10/08/2026\nTribunal judiciaire de Saint-Etienne",
        },
      },
      "petites_affiches",
    );

    expect(result.publicationAt).toBe("2026-08-10T00:00:00.000Z");
    expect(result.publicationKind).toBe("legal_notice");
  });

  it("does not borrow an unrelated hearing date when the legal-notice label has no date", () => {
    const result = extractTribunalListingEvidence(
      {
        source_blocks: {
          page_text:
            "Pub. légale\nDate de la vente : 15/10/2026\nTribunal judiciaire de Saint-Etienne",
        },
      },
      "petites_affiches",
    );

    expect(result.publicationAt).toBeNull();
    expect(result.publicationKind).toBeNull();
  });

  it("accepts an explicit AvoVentes source publication key and rejects internal timestamps", () => {
    const result = extractTribunalListingEvidence(
      {
        source_published_date: "2026-09-29",
        created_at: "2026-09-30T10:00:00.000Z",
        discovered_at: "2026-09-30T10:00:00.000Z",
        document_internal_date: "2026-09-30",
      },
      "avoventes",
    );

    expect(result.publicationAt).toBe("2026-09-29T00:00:00.000Z");
    expect(result.publicationKind).toBe("source_explicit");
  });

  it("does not treat news, court metadata or Immojudis publication timestamps as source publication", () => {
    const result = extractTribunalListingEvidence(
      {
        news_published_at: "2026-09-01",
        court: { published_at: "2026-09-02" },
        immojudis_published_at: "2026-09-03",
        published_at: "2026-09-04",
        raw_text: "Actualité publiée le 6 mai 2026",
      },
      "avoventes",
    );

    expect(result.publicationAt).toBeNull();
    expect(result.publicationKind).toBeNull();
  });

  it("accepts a plain source text value while ignoring an Immojudis news label", () => {
    expect(
      extractTribunalListingEvidence("Annonce publiée le 6 mai 2026", "licitor").publicationAt,
    ).toBe("2026-05-06T00:00:00.000Z");
    expect(
      extractTribunalListingEvidence("Immojudis — Annonce publiée le 6 mai 2026", "licitor")
        .publicationAt,
    ).toBeNull();
  });

  it("rejects invalid calendar dates in source labels", () => {
    const result = extractTribunalListingEvidence(
      { raw_text: "Annonce publiée le 31 février 2026" },
      "licitor",
    );

    expect(result.publicationAt).toBeNull();
  });

  it("keeps a legal overbid possibility unknown", () => {
    const result = extractTribunalListingEvidence(
      { raw_text: "La surenchère peut être formée dans le délai légal." },
      "licitor",
    );

    expect(result.overbidStatus).toBeNull();
    expect(result.overbidEvidence).toEqual([]);
  });

  it("does not classify the general legal wording about an avocat as a filed overbid", () => {
    const result = extractTribunalListingEvidence(
      { raw_text: "La surenchère est formée par acte d'avocat." },
      "petites_affiches",
    );

    expect(result.overbidStatus).toBeNull();
    expect(result.overbidEvidence).toEqual([]);
  });

  it("records an explicit negative overbid fact", () => {
    const result = extractTribunalListingEvidence(
      { raw_text: "Aucune surenchère n'a été déposée." },
      "licitor",
    );

    expect(result.overbidStatus).toBe("not_filed");
    expect(result.overbidEvidence[0]).toMatch(/Aucune surenchère/i);
  });

  it("flags an explicit notarial/judicial procedure conflict only with a named tribunal", () => {
    const conflict = extractTribunalListingEvidence(
      {
        raw_text: "Type de vente : Notariale\nTribunal Judiciaire de Saint-Etienne",
      },
      "petites_affiches",
    );
    const noTribunal = extractTribunalListingEvidence(
      { raw_text: "Type de vente : Notariale\nVente immobilière" },
      "petites_affiches",
    );
    const cityOnly = extractTribunalListingEvidence(
      { raw_text: "Type de vente : Notariale\nSaint-Etienne" },
      "petites_affiches",
    );

    expect(conflict.procedureConflict).toBe(true);
    expect(noTribunal.procedureConflict).toBe(false);
    expect(cityOnly.procedureConflict).toBe(false);
  });
});
