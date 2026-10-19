// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PremiumFeaturePreview } from "./PremiumFeaturePreview";

const mocks = vi.hoisted(() => ({ open: null as boolean | null }));
vi.mock("@/hooks/use-analysis-checkout-open", () => ({
  useAnalysisCheckoutOpen: () => mocks.open,
}));

afterEach(() => {
  cleanup();
  mocks.open = null;
});

describe("PremiumFeaturePreview : offre fermée ou ouverte", () => {
  const link = () => screen.getByRole("link", { name: "Découvrir l’offre Analyse" });

  it("offre fermée : un lien discret, pas le bouton or d'un achat qui n'existe pas encore", () => {
    mocks.open = false;
    render(<PremiumFeaturePreview title="Titre" description="Description" labels={["A"]} />);
    expect(link().className).not.toContain("bg-gold");
    expect(link().className).toContain("underline");
    expect(
      screen.getByText("L’offre Analyse n’est pas encore ouverte à la souscription."),
    ).toBeTruthy();
  });

  it("état encore inconnu : le lien discret aussi, jamais le bouton or", () => {
    render(<PremiumFeaturePreview title="Titre" description="Description" labels={["A"]} />);
    expect(link().className).not.toContain("bg-gold");
  });

  it("offre ouverte : le bouton or revient", () => {
    mocks.open = true;
    render(<PremiumFeaturePreview title="Titre" description="Description" labels={["A"]} />);
    expect(link().className).toContain("bg-gold");
  });
});

describe("PremiumFeaturePreview", () => {
  it("offers the offer page and a worked example of the analysis", () => {
    render(<PremiumFeaturePreview title="Titre" description="Description" labels={["A", "B"]} />);

    expect(
      screen.getByRole("link", { name: "Découvrir l’offre Analyse" }).getAttribute("href"),
    ).toBe("/offres");
    expect(
      screen.getByRole("link", { name: "Voir une analyse exemple" }).getAttribute("href"),
    ).toBe("/annonce-exemple");
  });
});
