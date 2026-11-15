// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PremiumFeaturePreview } from "./PremiumFeaturePreview";

const mocks = vi.hoisted(() => ({ open: null as boolean | null, trial: false }));
vi.mock("@/hooks/use-analysis-checkout-open", () => ({
  useAnalysisCheckoutOpen: () => mocks.open,
}));
vi.mock("@/hooks/use-launch-offer", () => ({
  useLaunchOffer: () => ({ active: mocks.trial, pending: false }),
}));

afterEach(() => {
  cleanup();
  mocks.open = null;
  mocks.trial = false;
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

  it("offre ouverte, essai fermé : l'abonnement seul, sans annoncer d'essai", () => {
    mocks.open = true;
    const { container } = render(
      <PremiumFeaturePreview title="Titre" description="Description" labels={["A"]} />,
    );
    expect(container.textContent).toContain(
      "L’offre Analyse est proposée sur abonnement mensuel, prélevé chaque mois jusqu’à résiliation, résiliable à tout moment.",
    );
    expect(container.textContent).not.toMatch(/offerte pendant|essai|7 jours/);
  });

  it("offre et essai ouverts : l'essai à l'inscription, puis l'abonnement", () => {
    mocks.open = true;
    mocks.trial = true;
    render(<PremiumFeaturePreview title="Titre" description="Description" labels={["A"]} />);
    expect(
      screen.getByText(
        /^L’offre Analyse est offerte pendant 7 jours à l’inscription, puis proposée/,
      ),
    ).toBeTruthy();
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

  it("tient en une ligne en version compacte, sans aperçu flouté", () => {
    const { container } = render(
      <PremiumFeaturePreview compact title="Titre" description="Description" labels={["A", "B"]} />,
    );

    expect(screen.getByText("Titre")).toBeTruthy();
    expect(screen.getByText("Description")).toBeTruthy();
    expect(screen.queryByText("A")).toBeNull();
    expect(container.querySelector("div[aria-hidden='true']")).toBeNull();
    expect(
      screen.getByRole("link", { name: "Découvrir l’offre Analyse" }).getAttribute("href"),
    ).toBe("/offres");
    expect(screen.queryByRole("link", { name: "Voir une analyse exemple" })).toBeNull();
  });
});
