import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ unit: false, analysis: false }));
vi.mock("@/lib/sale-unlock-checkout-readiness", () => ({
  saleUnlockCheckoutReadiness: () => ({ open: mocks.unit }),
}));
vi.mock("@/lib/analysis-checkout-readiness", () => ({
  analysisCheckoutReadiness: () => ({ open: mocks.analysis }),
}));

import { publicNextSalePricesText } from "./next-sale-prices.server";

describe("prix de la suite sur la fiche publique", () => {
  it("ne dit rien tant que l'achat à l'unité est fermé, même si l'abonnement est ouvert", () => {
    mocks.unit = false;
    mocks.analysis = true;
    expect(publicNextSalePricesText({})).toBeNull();
  });

  it("dit le prix de la vente à l'unité, et celui de l'abonnement seulement s'il se souscrit", () => {
    mocks.unit = true;
    mocks.analysis = false;
    expect(publicNextSalePricesText({})).toBe(
      "Le compte gratuit débloque une vente. Ensuite, chaque autre vente s’ouvre à l’unité pour 19 €, ou toutes avec l’offre Analyse.",
    );
    mocks.analysis = true;
    expect(publicNextSalePricesText({})).toBe(
      "Le compte gratuit débloque une vente. Ensuite, chaque autre vente s’ouvre à l’unité pour 19 €, ou toutes avec l’offre Analyse (59 € TTC / mois, sans engagement).",
    );
  });
});
