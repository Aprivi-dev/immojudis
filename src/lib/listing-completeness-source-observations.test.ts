import { describe, expect, it } from "vitest";
import fixture from "./source-observations-roundtrip.fixture.json";
import { EXAMPLE_SALE } from "./example-sale";
import { getListingCompleteness } from "./listing-completeness";
import type { AuctionSale } from "./types";

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
          captured_at: "2026-10-02T12:00:00Z",
          value: 5,
        }),
        expect.objectContaining({
          source_url: example.source_url,
          excerpt: expect.any(String),
          captured_at: "2026-10-02T12:00:00Z",
          value: 3,
        }),
      ]),
    );
  });

  it("projects the captured Notaires Bordeaux facts onto catalogue IDs", () => {
    const example = fixture.cases.find((item) => item.id === "real_notaires_bordeaux");
    if (!example) throw new Error("Missing real Notaires Bordeaux fixture case");

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
