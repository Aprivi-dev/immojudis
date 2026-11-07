// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-analysis-checkout-open", () => ({ useAnalysisCheckoutOpen: () => true }));

import { analysisOfferDescription } from "@/lib/offer-comparison";
import { unlockHighlightsText } from "@/lib/sale-unlocks";
import { DEFAULT_HOME_CEILING_FEATURE, HomeOffers } from "./HomeOffers";

afterEach(cleanup);

describe("HomeOffers free offer card", () => {
  it("announces the monthly unlocks of the free account, with one sign-up link under the cards", () => {
    render(<HomeOffers />);

    const card = screen.getByRole("heading", { name: "Découverte" }).closest("article")!;
    expect(
      within(card).getByText(
        "3 déblocages par mois : enchère plafond (ventes au tribunal et ventes notariales à la bougie) ou offre plafond (ventes notariales interactives), lecture des pièces, historique, selon la vente",
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
        ceilingFeature={analysisOfferDescription(["tribunal"])}
      />,
    );
    expect(document.body.textContent).toContain(
      "3 déblocages par mois : enchère plafond (ventes au tribunal), lecture des pièces, historique, selon la vente",
    );
    expect(document.body.textContent).toContain(
      "Le plafond des ventes au tribunal, avant de choisir celles qui méritent une visite.",
    );
    expect(document.body.textContent).not.toContain("offre plafond");
    expect(document.body.textContent).not.toContain("notariales");
  });

  it("ouvre la carte Analyse sur la description de /offres, pour les régimes ouverts par défaut", () => {
    expect(DEFAULT_HOME_CEILING_FEATURE).toBe(analysisOfferDescription());
    render(<HomeOffers />);
    const card = screen.getByRole("heading", { name: "Analyse" }).closest("article")!;
    expect(card.querySelector("li")?.textContent).toBe(
      "Le plafond des ventes au tribunal ou chez le notaire, avant de choisir celles qui méritent une visite.",
    );
  });

  it("keeps the other promises of the free account", () => {
    render(<HomeOffers />);
    const card = screen.getByRole("heading", { name: "Découverte" }).closest("article")!;
    expect(card.textContent).toContain("Accès aux annonces");
    expect(card.textContent).toContain("Jusqu’à 10 favoris");
    expect(card.textContent).toContain("Gratuit, sans limite de durée.");
  });
});
