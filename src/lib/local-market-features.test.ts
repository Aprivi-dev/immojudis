import { readFileSync } from "node:fs";
import { join } from "node:path";
import { latLngToCell } from "h3-js";
import { describe, expect, it } from "vitest";
import { hasLocalMarketExport, localMarketFeaturesFromArtifact } from "@/lib/local-market-features";

type Fixture = {
  points: Record<string, [number, number]>;
  cellIds: Record<string, Record<string, string>>;
  exports: Record<string, Record<string, unknown> & { resolutions: number[] }>;
  cases: Array<{
    label: string;
    export: string;
    latitude: number | null;
    longitude: number | null;
    expected: Record<string, number>;
  }>;
};

// Jeu de référence partagé avec services/data-pipeline/tests/test_local_market_parity.py : les
// valeurs attendues viennent de `lookup_exported_local_market` (Python).
const fixture = JSON.parse(
  readFileSync(
    join(process.cwd(), "services/data-pipeline/tests/fixtures/local_market_parity.json"),
    "utf8",
  ),
) as Fixture;

describe("variables de marché local : parité Python / TypeScript", () => {
  for (const testCase of fixture.cases) {
    it(`reproduit la référence Python : ${testCase.label}`, () => {
      const features = localMarketFeaturesFromArtifact(
        { localMarket: fixture.exports[testCase.export] },
        testCase.latitude ?? Number.NaN,
        testCase.longitude ?? Number.NaN,
      );
      expect(features).not.toBeNull();
      for (const [name, expected] of Object.entries(testCase.expected)) {
        expect(features![name as keyof typeof features], name).toBeCloseTo(expected, 10);
      }
    });
  }

  it("calcule les mêmes cellules H3 que la bibliothèque Python", () => {
    for (const [name, [latitude, longitude]] of Object.entries(fixture.points)) {
      for (const [resolution, cell] of Object.entries(fixture.cellIds[name])) {
        expect(
          latLngToCell(latitude, longitude, Number(resolution)),
          `${name} r${resolution}`,
        ).toBe(cell);
      }
    }
  });
});

describe("export localMarket illisible", () => {
  const valid = fixture.exports.apartment;
  const paris = fixture.points.paris;

  it("détecte la présence d'un export", () => {
    expect(hasLocalMarketExport({ localMarket: valid })).toBe(true);
    expect(hasLocalMarketExport({ localMarket: null })).toBe(false);
    expect(hasLocalMarketExport({})).toBe(false);
    expect(hasLocalMarketExport(null)).toBe(false);
  });

  it("renonce (null) plutôt que de calculer autrement : format inconnu, constantes ou cellules absentes", () => {
    const read = (localMarket: unknown) =>
      localMarketFeaturesFromArtifact({ localMarket }, paris[0], paris[1]);
    expect(read({ ...valid, formatVersion: 2 })).toBeNull();
    expect(read({ ...valid, algorithm: { minSample: 5 } })).toBeNull();
    expect(read({ ...valid, fallback: { mean: null, spread: 0.9 } })).toBeNull();
    expect(read({ ...valid, resolutions: [99] })).toBeNull();
    expect(read({ ...valid, cells: undefined })).toBeNull();
    expect(read("n'importe quoi")).toBeNull();
    expect(localMarketFeaturesFromArtifact({}, paris[0], paris[1])).toBeNull();
    expect(localMarketFeaturesFromArtifact(null, paris[0], paris[1])).toBeNull();
  });

  it("ignore une entrée de cellule mal formée et passe à la résolution suivante", () => {
    const cell9 = fixture.cellIds.paris["9"];
    const broken = {
      ...valid,
      cells: { ...(valid.cells as object), "9": { [cell9]: [40, "x", 0.2] } },
    };
    const features = localMarketFeaturesFromArtifact({ localMarket: broken }, paris[0], paris[1]);
    // Pas d'autre cellule qualifiante à Paris : repli.
    expect(features).toEqual({
      local_median_log: 8.1,
      local_spread_log: 0.9,
      local_sample_size_log: 0,
    });
  });
});
