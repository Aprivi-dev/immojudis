import { describe, expect, it } from "vitest";
import type { FloodPositionInput } from "./flood-risk";
import { floodPositionKey } from "./flood-risk-position.server";

function position(overrides: Partial<FloodPositionInput> = {}): FloodPositionInput {
  return {
    latitude: 47.399,
    longitude: 0.689,
    precision: "address",
    flags: [],
    communeInsee: "37261",
    ...overrides,
  };
}

describe("floodPositionKey", () => {
  it("ne copie aucune coordonnée", () => {
    const key = floodPositionKey(position());
    expect(key).not.toContain("47.39");
    expect(key).not.toContain("0.689");
    expect(key).toMatch(/^point:address:[0-9a-f]{16}$/);
  });

  it("change avec le point, la précision, les drapeaux douteux et (position imprécise) la commune", () => {
    const base = floodPositionKey(position());
    expect(floodPositionKey(position())).toBe(base);
    expect(floodPositionKey(position({ latitude: 47.4 }))).not.toBe(base);
    expect(floodPositionKey(position({ precision: "parcel" }))).not.toBe(base);
    expect(floodPositionKey(position({ flags: ["implausible_coordinates"] }))).not.toBe(base);
    expect(floodPositionKey(position({ precision: "street" }))).not.toBe(base);
    expect(floodPositionKey(position({ precision: "municipality" }))).toBe("approx:37261");
    expect(floodPositionKey(position({ precision: "municipality", communeInsee: "37018" }))).toBe(
      "approx:37018",
    );
    expect(floodPositionKey(position({ precision: null, communeInsee: null }))).toBe("approx:-");
  });

  it("un déplacement de moins d'un mètre ne change pas la clé", () => {
    expect(floodPositionKey(position({ latitude: 47.3990001 }))).toBe(floodPositionKey(position()));
  });
});
