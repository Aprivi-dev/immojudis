// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { buildCeilingHypotheses, type CeilingUserChoices } from "@/lib/bid-ceiling-defaults";
import { computeCeilingPlan, type CeilingHypotheses } from "@/lib/bid-ceiling-engine";
import type { MarketEstimate } from "@/lib/market.server";
import type { AuctionSale } from "@/lib/types";
import { CeilingPlanner } from "./CeilingPlanner";

afterEach(cleanup);

const sale = {
  id: "sale-1",
  department: "34",
  property_type: "apartment",
  occupancy_status: "vacant",
  starting_price_eur: 30_000,
  app_surface_m2: 80,
  app_surface_kind: "habitable",
} as unknown as AuctionSale;

const estimate = {
  actionable: true,
  estimatedValueEur: 160_000,
  medianPricePerM2: 2_000,
  p75PricePerM2: 2_200,
  qualityLabel: "forte",
  sampleSize: 20,
} as unknown as MarketEstimate;

function renderPlanner({
  saleOverride = sale,
  choices = {},
  market = estimate,
  tweak,
  valueReason,
}: {
  saleOverride?: AuctionSale;
  choices?: CeilingUserChoices;
  market?: MarketEstimate | null;
  tweak?: (hypotheses: CeilingHypotheses) => CeilingHypotheses;
  valueReason?: string;
} = {}) {
  const built = buildCeilingHypotheses(saleOverride, market, choices);
  const hypotheses = tweak ? tweak(built) : built;
  return render(
    <CeilingPlanner
      hypotheses={hypotheses}
      plan={computeCeilingPlan(hypotheses)}
      choices={choices}
      onChoicesChange={() => undefined}
      onReset={() => undefined}
      valueReason={valueReason}
    />,
  );
}

const RENT_WARNING =
  "Loyer non renseigné : le plafond ne tient pas compte du rendement. Saisissez un loyer.";

describe("CeilingPlanner verdict", () => {
  it("warns when a rental project has no reference rent for the department", () => {
    renderPlanner({
      saleOverride: { ...sale, department: "23" } as unknown as AuctionSale,
      choices: { project: "louer" },
    });

    expect(screen.getByText(RENT_WARNING)).toBeTruthy();
  });

  it("warns when the rent is 0", () => {
    renderPlanner({
      choices: { project: "louer" },
      tweak: (h) => ({ ...h, rent: { ...h.rent, monthly: 0, source: "saisi" } }),
    });

    expect(screen.getByText(RENT_WARNING)).toBeTruthy();
  });

  it("does not warn when the rent is known, or for other projects", () => {
    const { unmount } = renderPlanner({ choices: { project: "louer" } });
    expect(screen.queryByText(RENT_WARNING)).toBeNull();
    unmount();

    renderPlanner({
      saleOverride: { ...sale, department: "23" } as unknown as AuctionSale,
      choices: { project: "habiter" },
    });
    expect(screen.queryByText(RENT_WARNING)).toBeNull();
  });
});

describe("CeilingPlanner headline", () => {
  it("shows the ceiling when it is computed", () => {
    renderPlanner();

    expect(screen.queryByText(/À compléter/)).toBeNull();
    expect(screen.queryByText(/Pas d’enchère rentable/)).toBeNull();
  });

  it("says that no bid is profitable instead of showing « Aucune »", () => {
    renderPlanner({ choices: { works: { key: "devis", amount: 400_000 } } });

    expect(screen.getByText("Pas d’enchère rentable avec ces hypothèses")).toBeTruthy();
    expect(screen.queryByText("Aucune")).toBeNull();
    expect(
      screen.getByText(/aucune enchère n’est rentable : .* le coût total maximal\./),
    ).toBeTruthy();
  });

  it("gives the reason when the ceiling cannot be computed", () => {
    const { unmount } = renderPlanner({
      saleOverride: {
        ...sale,
        app_surface_m2: null,
        property_type: "other",
      } as unknown as AuctionSale,
    });
    expect(screen.getByText("À compléter : surface manquante")).toBeTruthy();
    unmount();

    renderPlanner({ market: null, valueReason: "estimation en cours" });
    expect(screen.getByText("À compléter : estimation en cours")).toBeTruthy();
  });
});

describe("CeilingPlanner readability", () => {
  it("uses one wording for the maximal total cost", () => {
    const { container } = renderPlanner({ choices: { works: { key: "devis", amount: 400_000 } } });
    expect(container.textContent).not.toContain("coût total acceptable");
    expect(container.textContent).toContain("coût total maximal");
  });

  it("calls the capped total cost the same way in the calculation steps", () => {
    renderPlanner();

    expect(screen.getByText("Coût total maximal")).toBeTruthy();
    expect(
      screen.getByText(/sous votre coût total maximal|dépassez votre coût total maximal/),
    ).toBeTruthy();
  });

  it("shows a chevron on every line of the calculation", () => {
    const { container } = renderPlanner();
    const summaries = container.querySelectorAll("#why-this-ceiling summary");

    expect(summaries.length).toBeGreaterThan(3);
    for (const summary of summaries) expect(summary.querySelector("svg")).not.toBeNull();
  });

  it("defines the trade terms in an accessible popover that links to the guide", () => {
    renderPlanner();
    const simulator = screen
      .getByRole("heading", { name: "Si vous l’emportez à…" })
      .closest("section")!;

    for (const name of ["adjudication", "émoluments"]) {
      expect(within(simulator).getByRole("button", { name: `Définition : ${name}` })).toBeTruthy();
    }
    const trigger = within(simulator).getByRole("button", { name: "Définition : adjudication" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const note = within(simulator).getByRole("note");
    expect(note.textContent).toContain("Attribution du bien au meilleur enchérisseur");
    expect(within(note).getByRole("link", { name: "En savoir plus" }).getAttribute("href")).toBe(
      "/ventes-immobilieres-judiciaires#lexique",
    );
  });
});
