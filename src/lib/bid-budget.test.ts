import { describe, expect, it } from "vitest";
import { maxPriceForBudget } from "./bid-budget";
import { computeAcquisitionCosts, DEFAULTS, type AcquisitionCostOptions } from "./profitability";

const HYPOTHESES: AcquisitionCostOptions[] = [
  {},
  { department: "75" },
  { department: "36" },
  { department: "33", fpt: 4_200, lawyerFees: 1_800, works: 30_000 },
  { fpt: 0, lawyerFees: 0, works: 0 },
  { department: "13", taxRegime: "vat" },
  { registrationRate: 0.0581 },
];

function expectOk(result: ReturnType<typeof maxPriceForBudget>) {
  if (result.status !== "ok") throw new Error(`attendu ok, reçu ${result.status}`);
  return result;
}

const total = (price: number, options: AcquisitionCostOptions) =>
  computeAcquisitionCosts({ ...options, price }).totalCost;

describe("maxPriceForBudget : exactitude", () => {
  it.each(
    HYPOTHESES.flatMap((options) =>
      [50_000, 123_456, 250_000, 1_000_000].map((b) => [options, b] as const),
    ),
  )(
    "rend le plus grand prix entier dont le coût total tient dans le budget (%j, %d €)",
    (options, budget) => {
      const result = expectOk(maxPriceForBudget(budget, options));
      expect(Number.isInteger(result.maxPrice)).toBe(true);
      expect(total(result.maxPrice, options)).toBeLessThanOrEqual(budget);
      // Un euro de plus ne tient plus : le prix est bien le maximum, arrondi à l'euro inférieur.
      expect(total(result.maxPrice + 1, options)).toBeGreaterThan(budget);
    },
  );

  it("reprend le détail du moteur de frais, sans second barème", () => {
    const options = { department: "33", fpt: 4_200, lawyerFees: 1_800, works: 30_000 };
    const result = expectOk(maxPriceForBudget(300_000, options));
    expect(result.costs).toEqual(computeAcquisitionCosts({ ...options, price: result.maxPrice }));
    expect(result.remaining).toBeCloseTo(300_000 - result.costs.totalCost, 6);
    expect(result.remaining).toBeGreaterThanOrEqual(0);
  });

  it("retrouve le prix d'origine quand le budget est exactement son coût total (aller-retour)", () => {
    for (const options of HYPOTHESES) {
      for (const price of [1, 6_500, 6_501, 17_000, 60_000, 60_001, 99_999, 180_000, 2_345_678]) {
        const budget = total(price, options);
        expect(
          expectOk(maxPriceForBudget(budget, options)).maxPrice,
          JSON.stringify([options, price]),
        ).toBe(price);
      }
    }
  });

  it("franchit correctement les tranches d'émoluments (6 500, 17 000 et 60 000 €)", () => {
    const options = { fpt: 0, lawyerFees: 0, works: 0 };
    for (const edge of [6_500, 17_000, 60_000]) {
      const atEdge = expectOk(maxPriceForBudget(total(edge, options), options));
      expect(atEdge.maxPrice).toBe(edge);
      const justBelow = expectOk(maxPriceForBudget(total(edge, options) - 0.01, options));
      expect(justBelow.maxPrice).toBe(edge - 1);
    }
  });

  it("arrondit à l'euro inférieur, jamais au plus proche", () => {
    const options = { fpt: 0, lawyerFees: 0, works: 0 };
    const between = (total(100_000, options) + total(100_001, options)) / 2;
    // Presque assez pour 100 001 € : on reste à 100 000 €.
    expect(expectOk(maxPriceForBudget(between, options)).maxPrice).toBe(100_000);
    expect(expectOk(maxPriceForBudget(total(100_001, options) - 0.001, options)).maxPrice).toBe(
      100_000,
    );
  });

  it("ne traite pas les centimes du budget comme un euro de plus", () => {
    const options = { fpt: 0, lawyerFees: 0, works: 0 };
    const budget = total(80_000, options);
    expect(expectOk(maxPriceForBudget(budget + 0.99, options)).maxPrice).toBe(80_000);
  });
});

describe("maxPriceForBudget : monotonie", () => {
  it("n'accorde jamais un prix plus bas à un budget plus haut", () => {
    for (const options of HYPOTHESES) {
      let previous = -1;
      for (let budget = 1_000; budget <= 400_000; budget += 997) {
        const result = maxPriceForBudget(budget, options);
        const price = result.status === "ok" ? result.maxPrice : 0;
        expect(price, JSON.stringify([options, budget])).toBeGreaterThanOrEqual(previous);
        previous = price;
      }
    }
  });

  it("ne gagne pas plus d'un euro de prix pour un euro de budget en plus", () => {
    // Les frais proportionnels font qu'un euro de budget vaut moins d'un euro de prix.
    const options = { fpt: 0, lawyerFees: 0, works: 0 };
    const a = expectOk(maxPriceForBudget(200_000, options)).maxPrice;
    const b = expectOk(maxPriceForBudget(200_001, options)).maxPrice;
    expect(b - a).toBeLessThanOrEqual(1);
  });

  it("donne un prix plus bas quand les hypothèses de frais augmentent", () => {
    const base = expectOk(maxPriceForBudget(200_000)).maxPrice;
    expect(expectOk(maxPriceForBudget(200_000, { works: 20_000 })).maxPrice).toBeLessThan(base);
    expect(expectOk(maxPriceForBudget(200_000, { lawyerFees: 4_000 })).maxPrice).toBeLessThan(base);
    expect(expectOk(maxPriceForBudget(200_000, { fpt: 8_000 })).maxPrice).toBeLessThan(base);
    expect(expectOk(maxPriceForBudget(200_000, { department: "75" })).maxPrice).toBeLessThan(
      expectOk(maxPriceForBudget(200_000, { department: "36" })).maxPrice,
    );
  });

  it("garde le prix sous le budget et les frais au-dessus de zéro", () => {
    for (const budget of [10_000, 75_000, 500_000, 5_000_000]) {
      const result = expectOk(maxPriceForBudget(budget));
      expect(result.maxPrice).toBeLessThan(budget);
      expect(result.costs.acquisitionFeesTotal).toBeGreaterThan(0);
    }
  });
});

describe("maxPriceForBudget : budget trop faible ou invalide", () => {
  it("signale un budget qui ne couvre pas les frais fixes, avec le minimum nécessaire", () => {
    const options = { fpt: 3_000, lawyerFees: 1_500, works: 0 };
    const result = maxPriceForBudget(4_000, options);
    expect(result.status).toBe("too_low");
    if (result.status !== "too_low") return;
    expect(result.minimumBudget).toBe(total(0, options));
    expect(result.minimumBudget).toBeGreaterThan(4_000);
    // Avec ce minimum exact, le prix maximal est de zéro euro.
    expect(expectOk(maxPriceForBudget(result.minimumBudget, options)).maxPrice).toBe(0);
  });

  it("compte les travaux dans le minimum nécessaire", () => {
    const result = maxPriceForBudget(20_000, { works: 50_000 });
    expect(result.status).toBe("too_low");
    if (result.status === "too_low") expect(result.minimumBudget).toBeGreaterThan(50_000);
  });

  it("utilise les valeurs d'exemple du simulateur quand aucune hypothèse n'est donnée", () => {
    const result = maxPriceForBudget(DEFAULTS.fpt + DEFAULTS.lawyerFees - 1);
    expect(result.status).toBe("too_low");
  });

  it("donne zéro euro, pas une erreur, quand il n'y a aucun frais fixe", () => {
    const options = { fpt: 0, lawyerFees: 0, works: 0 };
    expect(expectOk(maxPriceForBudget(0.5, options)).maxPrice).toBe(0);
  });

  it.each([0, -100, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "refuse le budget %s",
    (budget) => {
      expect(maxPriceForBudget(budget)).toEqual({ status: "invalid" });
    },
  );

  it("reste rapide et exact pour un très gros budget", () => {
    const result = expectOk(maxPriceForBudget(5e9, { department: "75" }));
    expect(total(result.maxPrice, { department: "75" })).toBeLessThanOrEqual(5e9);
    expect(total(result.maxPrice + 1, { department: "75" })).toBeGreaterThan(5e9);
  });
});
