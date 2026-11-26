// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ offer: { status: "loading" } as Record<string, unknown> }));
vi.mock("@/hooks/use-sale-unlock-purchase-offer", () => ({
  useSaleUnlockPurchaseOffer: () => mocks.offer,
}));

import { NextSalePrices } from "./NextSalePrices";

const ready = (analysisOpen: boolean, purchase: { label: string; amountCents: number } | null) => ({
  status: "ready",
  analysisOpen,
  analysisLabel: "59 € TTC / mois",
  analysisCents: 5900,
  purchase,
  firstMonthDeductionCents: 0,
});
const UNIT = { label: "19 €", amountCents: 1900 };
const text = () => (screen.getByTestId("prix").textContent ?? "").replace(/[\u00a0\u202f]/g, " ");

afterEach(() => {
  cleanup();
  mocks.offer = { status: "loading" };
});

describe("prix de la suite pour une personne sans compte", () => {
  it("dit le prix de la vente à l'unité et de l'abonnement, lus dans l'offre", () => {
    mocks.offer = ready(true, UNIT);
    render(<NextSalePrices testId="prix" />);
    expect(text()).toBe(
      "Ensuite, chaque autre vente s’ouvre à l’unité pour 19 €, ou toutes avec l’offre Analyse (59 € TTC / mois, sans engagement).",
    );
  });

  it("ne chiffre pas un abonnement qui ne se souscrit pas", () => {
    mocks.offer = ready(false, UNIT);
    render(<NextSalePrices testId="prix" />);
    expect(text()).toBe(
      "Ensuite, chaque autre vente s’ouvre à l’unité pour 19 €, ou toutes avec l’offre Analyse.",
    );
  });

  it("ne dit rien tant que l'achat à l'unité est fermé ou que l'offre n'est pas lue", () => {
    for (const offer of [{ status: "loading" }, ready(true, null)]) {
      mocks.offer = offer;
      const view = render(<NextSalePrices testId="prix" />);
      expect(screen.queryByTestId("prix")).toBeNull();
      view.unmount();
    }
  });
});
