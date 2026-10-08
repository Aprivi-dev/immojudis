import { describe, expect, it } from "vitest";
import { EXAMPLE_SALE } from "./example-sale";
import { getKeyFactReliabilities } from "./fact-reliability";
import { getListingPublicInformation } from "./listing-public-information";
import type { AuctionSale } from "./types";

function sale(overrides: Partial<AuctionSale> = {}): AuctionSale {
  return {
    ...EXAMPLE_SALE,
    raw_payload: {},
    source_blocks: null,
    source_blocks_by_source: null,
    source_description: null,
    description: null,
    documents: [],
    documents_rich: [],
    source_conflicts: [],
    ...overrides,
  };
}

function item(result: ReturnType<typeof getListingPublicInformation>, id: string) {
  return result.items.find((candidate) => candidate.id === id);
}

function observedFeature(
  field: string,
  value: unknown,
  sourceUrl = "https://source.test/annonce/1",
) {
  return {
    field,
    state: "observed",
    value,
    canonical_value: value,
    evidence: [
      {
        grade: "A",
        source_name: "Annonce d'origine",
        source_url: sourceUrl,
        excerpt: `${field} indiqué pour ce lot`,
        page: 4,
        captured_at: "2026-10-02T10:00:00Z",
      },
    ],
  };
}

describe("getListingPublicInformation", () => {
  it("projects a short buyer-facing catalogue and groups location and surface once", () => {
    const result = getListingPublicInformation(sale());

    expect(result.sections.map((section) => section.id)).toEqual([
      "property",
      "amenities",
      "energy",
      "occupancy",
      "sale",
    ]);
    expect(result.items.length).toBeLessThan(130);
    expect(result.items.filter((candidate) => candidate.id === "location")).toHaveLength(1);
    expect(result.items.filter((candidate) => candidate.id === "surface")).toHaveLength(1);
    expect(item(result, "surface")?.value).toContain("42,6");
    expect(result.priorityItems).toHaveLength(
      result.items.filter((candidate) => candidate.status !== "sourced").length,
    );
    expect(item(result, "adjudication_price_eur")).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("source_property_features");
    expect(JSON.stringify(result)).not.toContain("[object Object]");
  });

  it("keeps a canonical value reported when no field evidence is attached", () => {
    const result = getListingPublicInformation(
      sale({ bedrooms_count: 3, raw_payload: { source_property_features: {} } }),
    );

    expect(item(result, "bedrooms_count")).toMatchObject({
      value: "3 chambres",
      status: "reported",
      explanation: "Information disponible, source à préciser.",
      sources: [],
    });
  });

  it("marks a field sourced only when its own evidence has a safe URL and locator", () => {
    const result = getListingPublicInformation(
      sale({
        bedrooms_count: 3,
        raw_payload: {
          source_property_features: {
            bedrooms_count: observedFeature("bedrooms_count", 3),
          },
        },
      }),
    );
    const bedrooms = item(result, "bedrooms_count");

    expect(bedrooms?.status).toBe("sourced");
    expect(bedrooms?.sources).toEqual([
      expect.objectContaining({
        label: "Annonce d'origine",
        url: "https://source.test/annonce/1",
        excerpt: "bedrooms_count indiqué pour ce lot",
        page: 4,
        kind: "listing",
      }),
    ]);

    const unsafe = getListingPublicInformation(
      sale({
        bedrooms_count: 3,
        raw_payload: {
          source_property_features: {
            bedrooms_count: {
              ...observedFeature("bedrooms_count", 3, "javascript:alert(1)"),
              evidence: [
                {
                  grade: "A",
                  source_url: "javascript:alert(1)",
                  excerpt: "Trois chambres",
                },
              ],
            },
          },
        },
      }),
    );
    expect(item(unsafe, "bedrooms_count")).toMatchObject({ status: "reported", sources: [] });
  });

  it("preserves conflicts, including when a canonical value is present", () => {
    const sourceSale = sale({
      starting_price_eur: 92_000,
      source_conflicts: [
        {
          field: "starting_price_eur",
          selected: "92000",
          alternative: "95000",
          selected_source: "Annonce",
          alternative_source: "Document",
        },
      ],
    });
    const facts = getKeyFactReliabilities(sourceSale);
    const result = getListingPublicInformation(sourceSale, facts);

    expect(item(result, "starting_price_eur")).toMatchObject({
      value: "92 000 €",
      status: "conflict",
    });
    expect(result.priorityItems.map((candidate) => candidate.id)).toContain("starting_price_eur");
  });

  it("normalizes missing markers and labels the selected surface kind", () => {
    const result = getListingPublicInformation(
      sale({ occupancy_status: "À confirmer", app_surface_kind: "Carrez" }),
    );

    expect(item(result, "occupancy_status")).toMatchObject({ value: null, status: "missing" });
    expect(item(result, "surface")).toMatchObject({ label: "Surface Carrez" });
  });

  it("keeps zero counts when the source explicitly proves them", () => {
    const result = getListingPublicInformation(
      sale({
        rooms_count: 0,
        raw_payload: {
          source_property_features: {
            rooms_count: observedFeature("rooms_count", 0),
          },
        },
      }),
    );

    expect(item(result, "rooms_count")).toMatchObject({
      value: "0 pièces",
      status: "sourced",
    });
  });

  it("does not use evidence for a related field as proof for the displayed field", () => {
    const result = getListingPublicInformation(
      sale({
        bathrooms_count: 2,
        raw_payload: {
          source_property_features: {
            shower_rooms_count: observedFeature("shower_rooms_count", 1),
          },
        },
      }),
    );

    expect(item(result, "bathrooms_count")).toMatchObject({
      value: "2 salles de bains · 1 salle d’eau",
      status: "reported",
    });
    expect(item(result, "bathrooms_count")?.sources).toHaveLength(1);
  });

  it("formats payment deadlines and explains inaccessible sources", () => {
    const result = getListingPublicInformation(
      sale({
        source_blocks: EXAMPLE_SALE.source_blocks,
        source_presence: { dpe_class: { availability: "page_inaccessible" } },
      }),
    );

    expect(item(result, "payment_terms")?.value).toBe("60 jours");
    expect(item(result, "dpe_class")).toMatchObject({
      value: null,
      status: "missing",
      explanation: "La source ou le document n'est pas accessible pour le moment.",
    });
  });

  it("does not turn an unproved false boolean into a public negative fact", () => {
    const result = getListingPublicInformation(
      sale({ has_garden: false, has_garage: false, raw_payload: { source_property_features: {} } }),
    );

    expect(item(result, "garden")).toMatchObject({ value: null, status: "missing" });
    expect(item(result, "garage")).toMatchObject({ value: null, status: "missing" });
  });

  it("labels inferred surface as estimated and keeps the three counters exhaustive", () => {
    const result = getListingPublicInformation(
      sale({
        app_surface_m2: null,
        habitable_surface_m2: null,
        carrez_surface_m2: null,
        land_surface_m2: null,
        rooms_count: 1,
        property_type: "apartment",
      }),
    );

    expect(item(result, "surface")).toMatchObject({ status: "estimated", value: "20 m²" });
    expect(result.sourcedCount + result.missingCount + result.toConfirmCount).toBe(result.total);
    expect(
      result.items.every((candidate) =>
        ["sourced", "reported", "estimated", "missing", "conflict"].includes(candidate.status),
      ),
    ).toBe(true);
  });

  it("does not leak masked canonical values from raw observations", () => {
    const sourceSale = sale({
      starting_price_eur: 92_000,
      raw_payload: {
        source_property_features: {
          starting_price_eur: observedFeature("starting_price_eur", 92_000),
        },
      },
    });
    const facts = getKeyFactReliabilities(sourceSale);
    const masked = sale({
      starting_price_eur: null,
      raw_payload: sourceSale.raw_payload,
    });

    expect(item(getListingPublicInformation(masked, facts), "starting_price_eur")).toMatchObject({
      value: null,
      status: "missing",
      sources: [],
    });
  });

  it("allows the display adapter to block masked fields after projection", () => {
    const result = getListingPublicInformation(
      sale({
        rooms_count: 1,
        app_surface_m2: null,
        habitable_surface_m2: null,
        carrez_surface_m2: null,
        raw_payload: {
          source_property_features: {
            bedrooms_count: observedFeature("bedrooms_count", 3),
          },
        },
      }),
      null,
      { blockedFieldIds: new Set(["bedrooms_count", "surface"]) },
    );

    expect(item(result, "bedrooms_count")).toMatchObject({
      value: null,
      status: "reported",
      sources: [],
      explanation: "Cette information reste à confirmer avant de pouvoir être affichée.",
    });
    expect(item(result, "surface")).toMatchObject({ value: null, status: "reported", sources: [] });
  });

  it("uses the verified sale window when an online or state sale has no sale date", () => {
    const result = getListingPublicInformation(
      sale({
        sale_date: null,
        sale_venue_type: "online",
        sale_legal_framework: "unknown",
        sale_procedure: {
          venue_type: "online",
          legal_framework: "unknown",
          verification: { status: "cross_checked" },
          sale_window: {
            opens_at: "2026-10-15T09:30:00+02:00",
            closes_at: "2026-10-20T17:00:00+02:00",
          },
        },
      }),
    );
    const date = item(result, "sale_date");

    expect(date?.value).toContain("Du");
    expect(date?.value).toContain("au");
    expect(date?.status).toBe("reported");
    expect(date?.sources).toEqual([]);
  });

  it("keeps the canonical sale date and only its matching evidence when a schedule differs", () => {
    const result = getListingPublicInformation(
      sale({
        sale_date: "2026-10-15T09:30:00+02:00",
        sale_venue_type: "online",
        sale_legal_framework: "unknown",
        sale_procedure: {
          venue_type: "online",
          legal_framework: "unknown",
          verification: { status: "cross_checked" },
          sale_window: {
            opens_at: "2027-10-15T09:30:00+02:00",
            closes_at: "2027-10-20T17:00:00+02:00",
          },
        },
        raw_payload: {
          source_sale_schedule: {
            canonical_value: {
              opens_at: "2027-10-15T09:30:00+02:00",
              closes_at: "2027-10-20T17:00:00+02:00",
            },
            state: "observed",
            evidence: [
              {
                grade: "A",
                source_url: "https://source.test/schedule/1",
                excerpt: "Fenêtre de vente en ligne en octobre 2027",
                page: 7,
              },
            ],
          },
        },
      }),
    );

    expect(item(result, "sale_date")).toMatchObject({
      value: "15 octobre 2026 à 09:30",
      status: "reported",
      sources: [],
    });
  });

  it("groups bathrooms and shower rooms without claiming full sourcing from one proof", () => {
    const partial = getListingPublicInformation(
      sale({
        bathrooms_count: 2,
        raw_payload: {
          source_property_features: {
            bathrooms_count: observedFeature("bathrooms_count", 2),
            shower_rooms_count: observedFeature("shower_rooms_count", 1),
          },
        },
      }),
    );
    expect(item(partial, "bathrooms_count")).toMatchObject({
      value: "2 salles de bains · 1 salle d’eau",
      status: "sourced",
    });

    const oneProof = getListingPublicInformation(
      sale({
        bathrooms_count: 2,
        raw_payload: {
          source_property_features: {
            shower_rooms_count: observedFeature("shower_rooms_count", 1),
          },
        },
      }),
    );
    expect(item(oneProof, "bathrooms_count")).toMatchObject({
      value: "2 salles de bains · 1 salle d’eau",
      status: "reported",
    });
  });

  it("uses land criteria on a terrain and excludes housing-only facts", () => {
    const result = getListingPublicInformation(
      sale({
        property_type: "land",
        app_surface_m2: null,
        app_surface_kind: "land",
        habitable_surface_m2: null,
        carrez_surface_m2: null,
        land_surface_m2: 500,
        rooms_count: null,
        bedrooms_count: null,
      }),
    );

    expect(item(result, "surface")).toMatchObject({
      label: "Surface du terrain",
      value: "500 m² de terrain",
    });
    expect(item(result, "bedrooms_count")).toBeUndefined();
    expect(item(result, "dpe_class")).toBeUndefined();
    expect(item(result, "occupancy_status")).toBeUndefined();
  });

  it("does not let an unrelated PDF hide a missing conditions document", () => {
    const result = getListingPublicInformation(
      sale({
        documents: [],
        documents_rich: [
          {
            url: "https://docs.test/diagnostics.pdf",
            label: "Diagnostics techniques",
            type: "diagnostics_techniques",
            extraction_status: "ready",
          },
        ],
      }),
    );

    expect(item(result, "documents")).toMatchObject({
      value: "1 document disponible",
      status: "sourced",
      sources: [expect.objectContaining({ kind: "document", page: null })],
    });
    expect(item(result, "conditions_sale")).toMatchObject({
      value: null,
      status: "missing",
      explanation: "Cette information n’est pas disponible dans notre dossier à ce jour.",
      sources: [],
    });
  });
});
