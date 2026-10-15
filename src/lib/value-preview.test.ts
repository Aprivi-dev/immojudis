import { describe, expect, it } from "vitest";
import type { MarketEstimate } from "@/lib/market.server";
import { buildValuePreview } from "./value-preview";

const estimate = (fields: Partial<MarketEstimate>) => fields as MarketEstimate;

describe("buildValuePreview", () => {
  it("gives a rounded range and the gap with the starting price", () => {
    expect(
      buildValuePreview(
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
    });
  });

  it("falls back to ±15 % without bounds and reports a starting price above the value", () => {
    const preview = buildValuePreview(
      estimate({ actionable: true, estimatedValueEur: 100_000 }),
      110_000,
    );
    expect(preview).toMatchObject({ lowEur: 85_000, highEur: 115_000, discountPct: -10 });
  });

  it("shows nothing for an estimate that is not actionable", () => {
    expect(
      buildValuePreview(estimate({ actionable: false, estimatedValueEur: 100_000 }), 50_000)
        .available,
    ).toBe(false);
    expect(buildValuePreview(null, 50_000).available).toBe(false);
  });

  it("ne donne pas de pourcentage pour une mise à prix à moins de 30 % de la valeur", () => {
    const preview = buildValuePreview(
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
    const preview = buildValuePreview(
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
    expect(
      buildValuePreview(estimate({ actionable: true, estimatedValueEur: 100_000 }), 30_000),
    ).toMatchObject({ discountPct: 70, discountNotSignificant: false });
    expect(
      buildValuePreview(estimate({ actionable: true, estimatedValueEur: 100_000 }), 150_000),
    ).toMatchObject({ discountPct: -50, discountNotSignificant: false });
  });

  it("signale l'écart non significatif sans prix au m² quand la surface manque", () => {
    expect(
      buildValuePreview(estimate({ actionable: true, estimatedValueEur: 100_000 }), 10_000),
    ).toMatchObject({
      discountPct: null,
      discountNotSignificant: true,
      startingPricePerM2: null,
    });
  });

  it("n'affiche pas d'écart sans mise à prix", () => {
    expect(
      buildValuePreview(estimate({ actionable: true, estimatedValueEur: 100_000 }), null),
    ).toMatchObject({ available: true, discountPct: null, discountNotSignificant: false });
  });
});
