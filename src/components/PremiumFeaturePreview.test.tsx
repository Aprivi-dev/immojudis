// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PremiumFeaturePreview } from "./PremiumFeaturePreview";

vi.mock("@/hooks/use-analysis-checkout-open", () => ({ useAnalysisCheckoutOpen: () => null }));

afterEach(cleanup);

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
