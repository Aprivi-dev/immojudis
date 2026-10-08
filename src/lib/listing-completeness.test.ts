import { describe, expect, it } from "vitest";
import catalogue from "./listing-completeness-runtime.json";
import { EXAMPLE_SALE } from "./example-sale";
import {
  classifyListingCompletenessScore,
  getListingCompleteness,
  LISTING_COMPLETENESS_FIELD_COUNT,
  type CompletenessState,
} from "./listing-completeness";
import type { AuctionSale } from "./types";

const evidence = (text: string, source = "source-test") => [
  {
    grade: "A",
    source_name: source,
    source_url: "https://source.test/listing/1",
    excerpt: text,
    locator: "fiche#lot-1",
  },
];

const NUMERIC_FIELD_IDS = new Set([
  "auction_round",
  "starting_price_eur",
  "adjudication_price_eur",
  "rooms_count",
  "bedrooms_count",
  "bathrooms_count",
  "shower_rooms_count",
  "wc_count",
  "floor_number",
  "building_floor_count",
  "ceiling_height_m",
  "year_built",
  "energy_consumption_kwh_m2_year",
  "emissions_kg_co2_m2_year",
  "rent_eur",
  "coownership_charges_eur",
  "property_tax_eur",
  "photos_count",
  "photos_usable_count",
]);

function feature(field: string, state: CompletenessState, value: unknown, source = "source-test") {
  const base = { field, state, value, canonical_value: value };
  if (state === "inferred") {
    return {
      ...base,
      evidence: evidence("Valeur source à confirmer", source),
      inference: { method: "test_projection", input_fields: [field], confidence: 0.6 },
    };
  }
  if (state === "not_applicable") {
    return {
      ...base,
      evidence: [],
      reason: { code: "verified_scope", explanation: "Le champ ne concerne pas ce lot." },
    };
  }
  if (state === "explicitly_absent") {
    return { ...base, evidence: evidence(`Aucun ${field} n'est publié`, source) };
  }
  if (state === "conflict") {
    return {
      ...base,
      evidence: evidence("Deux valeurs différentes sont publiées", source),
      conflicts: [
        {
          source_url: "https://source.test/listing/1",
          excerpt: "Valeur A",
          captured_at: "2026-10-02T10:00:00Z",
          value: "A",
        },
      ],
    };
  }
  return { ...base, evidence: state === "unknown" ? [] : evidence(`${field} observé`, source) };
}

function sale(overrides: Partial<AuctionSale> = {}): AuctionSale {
  return {
    ...EXAMPLE_SALE,
    source_name: "encheres_immobilieres",
    source_url: "https://source.test/listing/1",
    source_urls: ["https://source.test/listing/1"],
    source_conflicts: [],
    raw_payload: {
      source_property_features: {
        source_conflicts: feature("source_conflicts", "explicitly_absent", []),
        source_name: feature("source_name", "observed", "encheres_immobilieres"),
        source_url: feature("source_url", "observed", "https://source.test/listing/1"),
        property_type: feature("property_type", "observed", "apartment"),
        source_title: feature("source_title", "observed", "Appartement T2"),
        address: feature("address", "observed", "1 rue du Lot"),
        location_precision: feature("location_precision", "observed", "exact"),
        sale_date: feature("sale_date", "observed", "2026-10-15T09:30:00+02:00"),
        surface_habitable_m2: feature("surface_habitable_m2", "observed", 42.6),
        starting_price_eur: feature("starting_price_eur", "observed", 92000),
        capture_text: feature("capture_text", "observed", "Page capturée et lisible"),
        conditions_sale: feature("conditions_sale", "observed", {
          url: "https://source.test/ccv.pdf",
        }),
        ...Object.fromEntries(
          catalogue.fields
            .filter((field) =>
              ["all", "apartment"].some((type) =>
                field.applicability.property_types?.includes(type),
              ),
            )
            .filter(
              (field) =>
                field.applicability.procedures?.includes("all") ||
                field.applicability.procedures?.includes("judicial"),
            )
            .map((field) => [
              field.id,
              feature(
                field.id,
                "observed",
                ["location_precision"].includes(field.id)
                  ? "exact"
                  : ["source_conflicts"].includes(field.id)
                    ? []
                    : NUMERIC_FIELD_IDS.has(field.id)
                      ? 1
                      : ["visit_dates", "source_urls", "cadastral_references"].includes(field.id)
                        ? ["1"]
                        : true,
              ),
            ]),
        ),
      },
      source_presence: {
        dpe_class: { availability: "page_inaccessible" },
      },
    },
    ...overrides,
  };
}

describe("getListingCompleteness", () => {
  it("uses the documented half-open score ranges before display rounding", () => {
    expect(classifyListingCompletenessScore(54.999)).toBe("incomplet");
    expect(classifyListingCompletenessScore(55)).toBe("a_enrichir");
    expect(classifyListingCompletenessScore(74.999)).toBe("a_enrichir");
    expect(classifyListingCompletenessScore(75)).toBe("decision_prete");
    expect(classifyListingCompletenessScore(89.999)).toBe("decision_prete");
    expect(classifyListingCompletenessScore(90)).toBe("riche");
  });

  it("evaluates all catalogue fields and selects Tribunal from verified procedure, not portal name", () => {
    const result = getListingCompleteness(sale());

    expect(LISTING_COMPLETENESS_FIELD_COUNT).toBe(130);
    expect(result.fields).toHaveLength(130);
    expect(result.profile.id).toBe("judicial_tribunal");
    expect(result.contextLabel).toBe("Tribunal");
    expect(result.procedure).toBe("judicial");
    expect(result.fields.find((field) => field.id === "land_surface_m2")?.state).toBe(
      "not_applicable",
    );
    expect(result.notApplicableFieldCount).toBeGreaterThan(0);
  });

  it("does not turn a false normalized boolean or raw text into an observed typed fact", () => {
    const result = getListingCompleteness(
      sale({
        has_garden: false,
        source_blocks: { page_text: "Chauffage collectif, 5e étage, terrasse du bâtiment." },
        raw_payload: { source_property_features: {} },
      }),
    );

    expect(result.fields.find((field) => field.id === "garden")?.state).toBe("unknown");
    expect(result.fields.find((field) => field.id === "heating_mode")?.state).toBe("unknown");
    expect(result.fields.find((field) => field.id === "floor_number")?.state).toBe("unknown");
  });

  it("reads the compact source_blocks.listing_completeness projection used by the detail view", () => {
    const result = getListingCompleteness(
      sale({
        raw_payload: null,
        source_blocks: {
          listing_completeness: {
            source_property_features: {
              heating_mode: feature("heating_mode", "observed", "collective"),
            },
          },
        },
      }),
    );

    expect(result.fields.find((field) => field.id === "heating_mode")?.state).toBe("observed");
    expect(result.fields.find((field) => field.id === "heating_mode")?.value).toBe("collective");
  });

  it("requires evidence for absence, keeps inaccessible facts in product score, and excludes them only from extractor coverage", () => {
    const result = getListingCompleteness(
      sale({
        raw_payload: {
          source_property_features: {
            source_conflicts: feature("source_conflicts", "explicitly_absent", []),
            dpe_class: {
              field: "dpe_class",
              state: "unknown",
              value: null,
              reason: { availability_reason: "page_inaccessible" },
            },
            garage: feature("garage", "explicitly_absent", false),
            heating_mode: feature("heating_mode", "observed", "individual"),
          },
        },
      }),
    );

    expect(result.fields.find((field) => field.id === "garage")?.state).toBe("explicitly_absent");
    expect(result.fields.find((field) => field.id === "dpe_class")?.state).toBe("unknown");
    expect(result.fields.find((field) => field.id === "dpe_class")?.extractionExcluded).toBe(true);
    expect(result.extractionCoverageScore).toBeGreaterThan(result.completenessScore);
  });

  it("caps a high raw score when a critical field is in conflict", () => {
    const result = getListingCompleteness(
      sale({
        raw_payload: {
          source_property_features: {
            sale_fees: feature("sale_fees", "conflict", 160),
          },
        },
      }),
    );

    expect(result.fields.find((field) => field.id === "sale_fees")?.state).toBe("conflict");
    expect(result.gateFailures.map((gate) => gate.id)).toContain("critical_conflict_free");
    expect(result.classification).toBe("a_enrichir");
  });

  it("does not allow an unverified portal to choose the sale procedure profile", () => {
    const result = getListingCompleteness(
      sale({
        sale_verification_status: "pending",
        sale_procedure: null,
        sale_venue_type: "notary",
        sale_legal_framework: "voluntary_notarial",
      }),
    );

    expect(result.procedure).toBe("unknown");
    expect(result.profile.id).toBe("generic");
    expect(result.contextLabel).toBe("Procédure à confirmer");
  });

  it("keeps the same portal on the Notaire profile when the verified procedure is notarial", () => {
    const result = getListingCompleteness(
      sale({
        sale_venue_type: "notary",
        sale_legal_framework: "voluntary_notarial",
        sale_verification_status: "cross_checked",
        sale_procedure: null,
      }),
    );

    expect(result.procedure).toBe("notarial");
    expect(result.profile.id).toBe("notarial");
    expect(result.contextLabel).toBe("Notaire");
  });

  it("gives a verified State legal framework precedence over a notarial venue", () => {
    const result = getListingCompleteness(
      sale({
        sale_venue_type: "notary",
        sale_legal_framework: "state_sale",
        sale_verification_status: "cross_checked",
        sale_procedure: null,
      }),
    );

    expect(result.procedure).toBe("state");
    expect(result.profile.id).toBe("state_disposal");
    expect(result.contextLabel).toBe("Cession d’État");
    expect(result.fields.find((field) => field.id === "sale_schedule")?.applicable).toBe(true);
  });
});
