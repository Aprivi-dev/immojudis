import { describe, expect, it } from "vitest";
import type { MarketEstimate } from "@/lib/market.server";
import { buildValuePreview } from "./value-preview";

const estimate = (fields: Partial<MarketEstimate>) => fields as MarketEstimate;

/** Un bien libre, sauf indication contraire : seul un bien libre reçoit un écart. */
const build = (
  fields: MarketEstimate | null,
  startingPrice: number | null,
  occupancyStatus: string | null = "vacant",
) => buildValuePreview(fields, startingPrice, occupancyStatus);

describe("buildValuePreview", () => {
  it("gives a rounded range and the gap with the starting price", () => {
    expect(
      build(
        estimate({
          actionable: true,
          estimatedValueEur: 201_400,
          estimatedValueLowEur: 178_650,
          estimatedValueHighEur: 224_300,
          qualityLabel: "correcte",
        }),
        140_000,
      ),
    ).toEqual({
      available: true,
      lowEur: 179_000,
      highEur: 224_000,
      discountPct: 30,
      discountNotSignificant: false,
      startingPricePerM2: null,
      reliability: "correcte",
      gapWithheld: null,
    });
  });

  it("falls back to ±15 % without bounds and reports a starting price above the value", () => {
    const preview = build(estimate({ actionable: true, estimatedValueEur: 100_000 }), 110_000);
    expect(preview).toMatchObject({ lowEur: 85_000, highEur: 115_000, discountPct: -10 });
  });

  it("shows nothing for an estimate that is not actionable", () => {
    expect(
      build(estimate({ actionable: false, estimatedValueEur: 100_000 }), 50_000).available,
    ).toBe(false);
    expect(build(null, 50_000).available).toBe(false);
  });

  it("ne donne pas de pourcentage pour une mise à prix à moins de 30 % de la valeur", () => {
    const preview = build(
      estimate({ actionable: true, estimatedValueEur: 200_000, subjectSurfaceM2: 50 }),
      50_000,
    );
    expect(preview).toMatchObject({
      available: true,
      discountPct: null,
      discountNotSignificant: true,
      startingPricePerM2: 1_000,
    });
    // La fourchette de valeur reste affichée : seul le pourcentage est retenu.
    expect(preview.lowEur).toBe(170_000);
    expect(preview.highEur).toBe(230_000);
  });

  it("ne donne pas de pourcentage pour une mise à prix à plus de 150 % de la valeur", () => {
    const preview = build(
      estimate({ actionable: true, estimatedValueEur: 100_000, subjectSurfaceM2: 40 }),
      160_000,
    );
    expect(preview).toMatchObject({
      discountPct: null,
      discountNotSignificant: true,
      startingPricePerM2: 4_000,
    });
  });

  it("garde le pourcentage aux bornes exactes des seuils", () => {
    expect(build(estimate({ actionable: true, estimatedValueEur: 100_000 }), 30_000)).toMatchObject(
      { discountPct: 70, discountNotSignificant: false },
    );
    expect(
      build(estimate({ actionable: true, estimatedValueEur: 100_000 }), 150_000),
    ).toMatchObject({ discountPct: -50, discountNotSignificant: false });
  });

  it("signale l'écart non significatif sans prix au m² quand la surface manque", () => {
    expect(build(estimate({ actionable: true, estimatedValueEur: 100_000 }), 10_000)).toMatchObject(
      {
        discountPct: null,
        discountNotSignificant: true,
        startingPricePerM2: null,
      },
    );
  });

  it("n'affiche pas d'écart sans mise à prix", () => {
    expect(build(estimate({ actionable: true, estimatedValueEur: 100_000 }), null)).toMatchObject({
      available: true,
      discountPct: null,
      discountNotSignificant: false,
    });
  });

  describe("occupation : même règle que la bande publique", () => {
    const sure = estimate({
      actionable: true,
      estimatedValueEur: 100_000,
      estimatedValueLowEur: 90_000,
      estimatedValueHighEur: 110_000,
      subjectSurfaceM2: 50,
    });

    it.each([
      ["occupied", "occupied"],
      ["rented", "occupied"],
      ["owner_occupied", "occupied"],
      ["unknown", "occupancy_unknown"],
      ["", "occupancy_unknown"],
      [null, "occupancy_unknown"],
      [undefined, "occupancy_unknown"],
    ] as const)(
      "garde la fourchette mais retient l'écart pour une occupation %s",
      (occupancy, withheld) => {
        const preview = buildValuePreview(sure, 40_000, occupancy);
        expect(preview).toMatchObject({
          available: true,
          lowEur: 90_000,
          highEur: 110_000,
          discountPct: null,
          discountNotSignificant: false,
          startingPricePerM2: null,
          gapWithheld: withheld,
        });
      },
    );

    it("retient aussi la mention « écart non significatif » pour un bien occupé", () => {
      expect(buildValuePreview(sure, 10_000, "occupied")).toMatchObject({
        discountPct: null,
        discountNotSignificant: false,
        startingPricePerM2: null,
        gapWithheld: "occupied",
      });
    });

    it.each(["vacant", "libre", "Inoccupé"])("donne l'écart d'un bien %s", (occupancy) => {
      expect(buildValuePreview(sure, 40_000, occupancy)).toMatchObject({
        discountPct: 60,
        gapWithheld: null,
      });
    });
  });
});
