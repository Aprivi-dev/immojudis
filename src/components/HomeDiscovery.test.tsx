// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-analysis-checkout-open", () => ({ useAnalysisCheckoutOpen: () => true }));

import { HomeDiscovery } from "./HomeDiscovery";

afterEach(cleanup);

describe("HomeDiscovery free offer card", () => {
  it("announces the monthly unlocks of the free account and sends to account creation", () => {
    render(<HomeDiscovery />);

    const card = screen.getByRole("heading", { name: "Découverte" }).closest("article")!;
    expect(
      within(card).getByText(
        "3 ventes débloquées par mois : enchère plafond (ventes au tribunal), lecture des pièces, historique, selon la vente",
      ),
    ).toBeTruthy();
    const cta = within(card).getByRole("link", { name: /Créer mon compte gratuit/ });
    expect(cta.getAttribute("href")).toBe("/login?mode=investor");
    expect(within(card).queryByRole("link", { name: /Explorer les ventes/ })).toBeNull();
  });

  it("keeps the other promises of the free account", () => {
    render(<HomeDiscovery />);
    const card = screen.getByRole("heading", { name: "Découverte" }).closest("article")!;
    expect(card.textContent).toContain("Accès aux annonces");
    expect(card.textContent).toContain("Jusqu’à trois favoris");
  });
});
