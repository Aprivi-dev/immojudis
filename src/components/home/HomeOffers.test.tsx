// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-analysis-checkout-open", () => ({ useAnalysisCheckoutOpen: () => true }));

import { unlockHighlightsText } from "@/lib/sale-unlocks";
import { HomeOffers } from "./HomeOffers";

afterEach(cleanup);

describe("HomeOffers free offer card", () => {
  it("announces the monthly unlocks of the free account, with one sign-up link under the cards", () => {
    render(<HomeOffers />);

    const card = screen.getByRole("heading", { name: "Découverte" }).closest("article")!;
    expect(
      within(card).getByText(
        "3 ventes débloquées par mois : enchère plafond (ventes au tribunal et ventes notariales à la bougie) ou offre plafond (ventes notariales interactives), lecture des pièces, historique, selon la vente",
      ),
    ).toBeTruthy();
    const cta = screen.getByRole("link", { name: /Créer mon compte gratuit/ });
    expect(cta.getAttribute("href")).toBe("/login?mode=investor");
    expect(cta.closest("article")).toBeNull();
  });

  it("says what the server read of the fee regime switch: tribunal only, no « offre plafond »", () => {
    render(
      <HomeOffers
        unlockHighlights={unlockHighlightsText(["tribunal"])}
        ceilingFeature="Enchère plafond et travaux"
      />,
    );
    expect(document.body.textContent).toContain(
      "3 ventes débloquées par mois : enchère plafond (ventes au tribunal), lecture des pièces, historique, selon la vente",
    );
    expect(document.body.textContent).not.toContain("offre plafond");
  });

  it("keeps the other promises of the free account", () => {
    render(<HomeOffers />);
    const card = screen.getByRole("heading", { name: "Découverte" }).closest("article")!;
    expect(card.textContent).toContain("Accès aux annonces");
    expect(card.textContent).toContain("Jusqu’à 10 favoris");
    expect(card.textContent).toContain("Gratuit, sans limite de durée.");
  });
});
