import { describe, expect, it } from "vitest";
import { adjudicationVersusCeilingLine } from "./adjudication-vs-ceiling";

const NOW = new Date("2026-11-10T12:00:00Z");
const PAST = "2026-10-01T09:00:00Z";

const line = (overrides: Partial<Parameters<typeof adjudicationVersusCeilingLine>[0]> = {}) =>
  adjudicationVersusCeilingLine({
    adjudicationEur: 130_000,
    ceilingEur: 118_000,
    saleDate: PAST,
    now: NOW,
    ...overrides,
  });

describe("après la vente : prix d'adjudication et plafond estimé", () => {
  it("dit « au-dessus » quand le prix dépasse le plafond estimé", () => {
    expect(line()).toMatch(
      /^Adjugée 130\s000\s€ : au-dessus de votre enchère plafond estimée \(118\s000\s€\)$/u,
    );
  });

  it("dit « en dessous » ou « au niveau de », sur un ton neutre", () => {
    expect(line({ adjudicationEur: 100_000 })).toMatch(
      /en dessous de votre enchère plafond estimée/u,
    );
    expect(line({ adjudicationEur: 118_000 })).toMatch(
      /au niveau de votre enchère plafond estimée/u,
    );
    for (const text of [line(), line({ adjudicationEur: 100_000 })]) {
      expect(text).not.toMatch(/bonne affaire|raté|manqué|gagn|perdu/i);
    }
  });

  it("parle d'offre plafond et de vente pour une vente par offres", () => {
    expect(line({ ceilingTerm: "offre plafond", byOffers: true })).toMatch(
      /^Vendue 130\s000\s€ : au-dessus de votre offre plafond estimée/u,
    );
  });

  it("n'écrit rien sans prix positif, sans plafond ou pour une vente pas encore passée", () => {
    expect(line({ adjudicationEur: null })).toBeNull();
    expect(line({ adjudicationEur: 0 })).toBeNull();
    expect(line({ ceilingEur: null })).toBeNull();
    expect(line({ ceilingEur: 0 })).toBeNull();
    expect(line({ saleDate: "2026-12-01T09:00:00Z" })).toBeNull();
    expect(line({ saleDate: null })).toBeNull();
  });
});
