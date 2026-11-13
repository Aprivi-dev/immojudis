import { describe, expect, it } from "vitest";
import { PEPITE_CRITERION_LABELS } from "./pepite-reasons";

describe("PEPITE_CRITERION_LABELS", () => {
  it("écrit les seuils de la règle au format français commun (montant en euros, pourcentage)", () => {
    const { size_value_supported, market_not_declining, gap_significant } = PEPITE_CRITERION_LABELS;

    expect(size_value_supported.pass).toMatch(/valeur estimée d’au plus \d{1,3}(\s\d{3})+\s€$/);
    expect(market_not_declining.fail).toMatch(/^Prix du marché local en baisse de plus de \d+\s% /);
    expect(gap_significant.fail).toMatch(/mise à prix sous \d+\s% ou au-dessus de \d+\s% /);
  });
});
