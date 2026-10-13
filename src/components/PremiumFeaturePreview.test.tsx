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
});
