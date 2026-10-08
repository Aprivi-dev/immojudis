import { describe, expect, it } from "vitest";
import { EXAMPLE_SALE } from "./example-sale";
import { getListingCompleteness } from "./listing-completeness";
import type { AuctionSale } from "./types";

const capturedAt = "2026-10-02T12:00:00Z";

function evidence(sourceUrl: string, quote: string, grade: "A" | "B" | "C" = "B") {
  return [
    {
      source_url: sourceUrl,
      locator: `${sourceUrl}#text`,
      quote,
      grade,
      captured_at: capturedAt,
    },
  ];
}

const inferredSourceUrl = "https://source.test/roundtrip/inferred";
const conflictSourceUrl = "https://source.test/roundtrip/conflict";
const catalogueSourceUrl = "https://source.test/roundtrip/catalogue";

const fixture = {
  cases: [
    {
      id: "inferred_rooms_count",
      field: "rooms_count",
      source_url: inferredSourceUrl,
      source_field_observations: {
        rooms_count: {
          value: 5,
          state: "inferred",
          evidence: evidence(inferredSourceUrl, "rooms_count=5", "B"),
          inference: {
            method: "parser_field_without_explicit_source_text",
            input_fields: ["rooms_count"],
            confidence: 0.6,
          },
        },
      },
    },
    {
      id: "conflict_rooms_count",
      field: "rooms_count",
      source_url: conflictSourceUrl,
      source_field_observations: {
        rooms_count: {
          value: 5,
          state: "conflict",
          evidence: evidence(conflictSourceUrl, "rooms_count=5", "B"),
          conflicts: [
            {
              source_url: conflictSourceUrl,
              excerpt: "rooms_count=5",
              captured_at: capturedAt,
              value: 5,
            },
            {
              source_url: conflictSourceUrl,
              excerpt: "Appartement T3",
              captured_at: capturedAt,
              value: 3,
            },
          ],
        },
      },
    },
    {
      id: "synthetic_catalogue_observations",
      field: "surface_habitable_m2",
      source_url: catalogueSourceUrl,
      source_field_observations: {
        surface_habitable_m2: {
          value: 76.36,
          state: "observed",
          evidence: evidence(catalogueSourceUrl, "surface_habitable_m2=76.36"),
        },
        surface_carrez_m2: {
          value: 76.36,
          state: "observed",
          evidence: evidence(catalogueSourceUrl, "surface_carrez_m2=76.36"),
        },
        floor_number: {
          value: 5,
          state: "observed",
          evidence: evidence(catalogueSourceUrl, "floor_number=5", "A"),
        },
        heating_mode: {
          value: "collective",
          state: "observed",
          evidence: evidence(catalogueSourceUrl, "heating_mode=collective", "A"),
        },
        heating_energy: {
          value: "heat_pump",
          state: "conflict",
          evidence: evidence(catalogueSourceUrl, "heating_energy=heat_pump"),
          conflicts: [
            {
              source_url: catalogueSourceUrl,
              excerpt: "heating_energy=heat_pump",
              captured_at: capturedAt,
              value: "heat_pump",
            },
            {
              source_url: catalogueSourceUrl,
              excerpt: "heating_energy=gas",
              captured_at: capturedAt,
              value: "gas",
            },
          ],
        },
        heating_distribution: {
          value: "radiators",
          state: "observed",
          evidence: evidence(catalogueSourceUrl, "heating_distribution=radiators", "A"),
        },
        dpe_class: {
          value: "C",
          state: "observed",
          evidence: evidence(catalogueSourceUrl, "dpe_class=C"),
        },
        energy_consumption_kwh_m2_year: {
          value: 178,
          state: "observed",
          evidence: evidence(catalogueSourceUrl, "energy_consumption_kwh_m2_year=178"),
        },
        ges_class: {
          value: "B",
          state: "observed",
          evidence: evidence(catalogueSourceUrl, "ges_class=B"),
        },
        emissions_kg_co2_m2_year: {
          value: 7,
          state: "observed",
          evidence: evidence(catalogueSourceUrl, "emissions_kg_co2_m2_year=7"),
        },
        dpe_established_at: {
          value: "2026-06-30",
          state: "observed",
          evidence: evidence(catalogueSourceUrl, "dpe_established_at=2026-06-30"),
        },
        property_tax_eur: {
          value: 1213,
          state: "observed",
          evidence: evidence(catalogueSourceUrl, "property_tax_eur=1213"),
        },
      },
    },
  ],
} as const;

type RoundtripCase = (typeof fixture.cases)[number];

function saleForCase(example: RoundtripCase): AuctionSale {
  return {
    ...EXAMPLE_SALE,
    id: `roundtrip-${example.id}`,
    source_name: "info_encheres",
    source_url: example.source_url,
    source_urls: [example.source_url],
    raw_payload: {
      source_field_observations: example.source_field_observations,
    },
  } as AuctionSale;
}

describe("Python source observation contract round trip", () => {
  it("keeps inferred observations known and carries their inference proof", () => {
    const example = fixture.cases.find((item) => item.id === "inferred_rooms_count");
    if (!example) throw new Error("Missing inferred fixture case");

    const field = getListingCompleteness(saleForCase(example)).fields.find(
      (item) => item.id === example.field,
    );

    expect(field?.state).toBe("inferred");
    expect(field?.value).toBe(5);
    expect(field?.inference).toMatchObject({
      method: "parser_field_without_explicit_source_text",
      input_fields: ["rooms_count"],
      confidence: 0.6,
    });
  });

  it("keeps conflicting observations conflictual with value-level proof", () => {
    const example = fixture.cases.find((item) => item.id === "conflict_rooms_count");
    if (!example) throw new Error("Missing conflict fixture case");

    const field = getListingCompleteness(saleForCase(example)).fields.find(
      (item) => item.id === example.field,
    );

    expect(field?.state).toBe("conflict");
    expect(field?.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_url: example.source_url,
          excerpt: expect.any(String),
          captured_at: capturedAt,
          value: 5,
        }),
        expect.objectContaining({
          source_url: example.source_url,
          excerpt: expect.any(String),
          captured_at: capturedAt,
          value: 3,
        }),
      ]),
    );
  });

  it("projects synthetic captured facts onto catalogue IDs", () => {
    const example = fixture.cases.find((item) => item.id === "synthetic_catalogue_observations");
    if (!example) throw new Error("Missing synthetic catalogue fixture case");

    const result = getListingCompleteness(saleForCase(example));
    const expected = {
      surface_habitable_m2: ["observed", 76.36],
      surface_carrez_m2: ["observed", 76.36],
      floor_number: ["observed", 5],
      heating_mode: ["observed", "collective"],
      heating_energy: ["conflict", "heat_pump"],
      heating_distribution: ["observed", "radiators"],
      dpe_class: ["observed", "C"],
      energy_consumption_kwh_m2_year: ["observed", 178],
      ges_class: ["observed", "B"],
      emissions_kg_co2_m2_year: ["observed", 7],
      dpe_established_at: ["observed", "2026-06-30"],
      property_tax_eur: ["observed", 1213],
    } as const;

    for (const [id, [state, value]] of Object.entries(expected)) {
      const field = result.fields.find((item) => item.id === id);
      expect(field?.state, id).toBe(state);
      expect(field?.value, id).toBe(value);
    }
    const heatingEnergy = result.fields.find((item) => item.id === "heating_energy");
    expect(heatingEnergy?.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "heat_pump" }),
        expect.objectContaining({ value: "gas" }),
      ]),
    );
    expect(result.fields.find((item) => item.id === "occupancy_status")?.state).toBe("unknown");
  });
});
