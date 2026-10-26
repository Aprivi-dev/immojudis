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
  onEditWorks,
}: {
  saleOverride?: AuctionSale;
  choices?: CeilingUserChoices;
  market?: MarketEstimate | null;
  tweak?: (hypotheses: CeilingHypotheses) => CeilingHypotheses;
  valueReason?: string;
  onEditWorks?: () => void;
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
      onEditWorks={onEditWorks}
    />,
  );
}

const RENT_WARNING =
  "Loyer non renseigné : le plafond ne tient pas compte du rendement. Saisissez un loyer.";

describe("CeilingPlanner titre", () => {
  it("dit que le montant est une simulation, avec le profil choisi", () => {
    renderPlanner();
    expect(screen.getByText(/^Enchère plafond \(simulation\) · /)).toBeTruthy();
  });
});

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
    expect(screen.queryByText(/Aucun prix ne tient/)).toBeNull();
  });

  it("says that no price holds, with the reason, instead of showing « Aucune »", () => {
    renderPlanner({ choices: { works: { key: "devis", amount: 400_000 } } });

    expect(screen.getByText("Aucun prix ne tient")).toBeTruthy();
    expect(screen.queryByText("Aucune")).toBeNull();
    expect(
      screen.getByText(
        "Les frais, les travaux et la libération dépassent déjà le budget que permettent la valeur du bien et vos objectifs.",
      ),
    ).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/rentable|Marge de sécurité non tenue/);
  });

  it("says how far above the starting price the ceiling stands, in words", () => {
    renderPlanner({
      saleOverride: { ...sale, starting_price_eur: 1_000 } as unknown as AuctionSale,
    });
    const verdict = screen.getByText(/Selon vos hypothèses, vous pouvez enchérir jusqu’à/);
    expect(verdict.textContent).toMatch(
      /^Selon vos hypothèses, vous pouvez enchérir jusqu’à .+€, soit .+€ au-dessus de la mise à prix\./,
    );
    expect(verdict.textContent).not.toContain("Peu d’écart");
  });

  it("flags a narrow margin above the starting price", () => {
    const maxBid = computeCeilingPlan(buildCeilingHypotheses(sale, estimate)).maxBid;
    renderPlanner({
      saleOverride: { ...sale, starting_price_eur: maxBid - 1_000 } as unknown as AuctionSale,
    });

    const verdict = screen.getByText(
      /^Peu d’écart avec la mise à prix : selon vos hypothèses, vous pouvez enchérir jusqu’à/,
    );
    expect(verdict.textContent).toMatch(/, soit 1\s000\s€ au-dessus de la mise à prix\./);
  });

  it("states the shortfall in euros and percent when the ceiling is under the starting price", () => {
    const maxBid = computeCeilingPlan(buildCeilingHypotheses(sale, estimate)).maxBid;
    renderPlanner({
      saleOverride: { ...sale, starting_price_eur: maxBid * 2 } as unknown as AuctionSale,
    });

    const verdict = screen.getByText(/Avec ces hypothèses, votre enchère plafond \(/);
    expect(verdict.textContent).toMatch(
      /^Avec ces hypothèses, votre enchère plafond \(.+€\) est .+€ \(50\s%\) sous la mise à prix : le bien ne tient pas à son prix de départ\.$/,
    );
  });

  it("starts the simulator at the ceiling, not the starting price, when the ceiling is below it", () => {
    const maxBid = computeCeilingPlan(buildCeilingHypotheses(sale, estimate)).maxBid;
    renderPlanner({
      saleOverride: { ...sale, starting_price_eur: maxBid * 2 } as unknown as AuctionSale,
    });

    const input = screen.getByRole("spinbutton", {
      name: /Montant de l’enchère simulée/,
    }) as HTMLInputElement;
    expect(Number(input.value)).toBe(maxBid);
    const quickBids = screen
      .getAllByRole("button")
      .filter((button) => /^(Plafond|Mise à prix) · /.test(button.textContent ?? ""));
    expect(quickBids.map((button) => button.textContent?.split(" · ")[0])).toEqual([
      "Plafond",
      "Mise à prix",
    ]);
  });

  it("follows the ceiling when it crosses the starting price, instead of staying frozen", () => {
    const maxBid = computeCeilingPlan(buildCeilingHypotheses(sale, estimate)).maxBid;
    const planner = (startingPrice: number) => {
      const hypotheses = buildCeilingHypotheses(
        { ...sale, starting_price_eur: startingPrice } as unknown as AuctionSale,
        estimate,
        {},
      );
      return (
        <CeilingPlanner
          hypotheses={hypotheses}
          plan={computeCeilingPlan(hypotheses)}
          choices={{}}
          onChoicesChange={() => undefined}
          onReset={() => undefined}
        />
      );
    };
    const input = () =>
      screen.getByRole("spinbutton", { name: /Montant de l’enchère simulée/ }) as HTMLInputElement;

    const { rerender } = render(planner(30_000));
    expect(Number(input().value)).toBe(30_000);

    rerender(planner(maxBid * 2));
    expect(Number(input().value)).toBe(maxBid);

    rerender(planner(30_000));
    expect(Number(input().value)).toBe(30_000);
  });

  it("shows no cash calendar when no price holds", () => {
    renderPlanner({ choices: { works: { key: "devis", amount: 400_000 } } });

    expect(screen.getByText("Aucun prix ne tient")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Trésorerie à prévoir" })).toBeNull();
  });

  it("does not ask to read the preliminary fees, nor call them a default, once the user entered them", () => {
    const { container, unmount } = renderPlanner();
    expect(container.textContent).toContain("Fiabilité : À consolider");
    expect(container.textContent).toContain(
      "Lisez dans le cahier des conditions de vente le montant des frais préalables",
    );
    unmount();

    const entered = renderPlanner({ choices: { fpt: 6_000 } });
    expect(entered.container.textContent).toContain("Fiabilité : Solide");
    expect(entered.container.textContent).not.toContain("Lisez dans le cahier des conditions");
    expect(entered.container.textContent).not.toContain("Reste à confirmer : frais préalables");
  });

  it("keeps starting the simulator at the starting price when the ceiling is above it", () => {
    renderPlanner();

    const input = screen.getByRole("spinbutton", {
      name: /Montant de l’enchère simulée/,
    }) as HTMLInputElement;
    expect(Number(input.value)).toBe(30_000);
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
      "/ventes-immobilieres-judiciaires#lexique-adjudication",
    );
  });
});

describe("CeilingPlanner : vocabulaire du plafond", () => {
  it("dit que le bien ne tient pas à son prix de départ quand le plafond est sous la mise à prix, sans conseiller", () => {
    const { container } = renderPlanner({
      saleOverride: { ...sale, starting_price_eur: 300_000 } as unknown as AuctionSale,
    });
    const verdict = screen.getByText(/Avec ces hypothèses, votre enchère plafond \(/);
    expect(verdict.textContent).toMatch(
      /sous la mise à prix : le bien ne tient pas à son prix de départ\./,
    );
    expect(container.textContent).not.toContain("mieux vaut");
    expect(container.textContent).not.toMatch(/conseillée/);
  });

  it("définit les termes de procédure de la liste de vérifications et du simulateur", () => {
    renderPlanner({ choices: { project: "louer" } });
    const checklist = screen
      .getByRole("heading", { name: "À vérifier avant l’audience" })
      .closest("section")!;
    expect(
      within(checklist).getByRole("button", { name: "Définition : droit de préemption" }),
    ).toBeTruthy();
    expect(
      within(checklist).getByRole("button", { name: "Définition : frais préalables" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Définition : cahier des conditions de vente" }),
    ).toBeTruthy();
    const simulator = screen
      .getByRole("heading", { name: "Si vous l’emportez à…" })
      .closest("section")!;
    expect(
      within(simulator).getByRole("button", { name: "Définition : frais préalables" }),
    ).toBeTruthy();
    expect(checklist.textContent).toContain(
      "Selon la situation du bien, la commune (ou un autre titulaire prévu par la loi) peut exercer un droit de préemption et se substituer à l’adjudicataire dans les 30 jours de l’adjudication. Demandez à votre avocat si le bien est concerné.",
    );
    expect(checklist.textContent).not.toContain("dans le mois");
  });

  it("définit le procès-verbal descriptif quand l'occupation est inconnue", () => {
    renderPlanner({
      saleOverride: { ...sale, occupancy_status: null } as unknown as AuctionSale,
    });
    const checklist = screen
      .getByRole("heading", { name: "À vérifier avant l’audience" })
      .closest("section")!;
    expect(checklist.textContent).toContain(
      "Vérifiez l’occupation dans le procès-verbal descriptif.",
    );
    expect(
      within(checklist).getAllByRole("button", { name: "Définition : procès-verbal descriptif" })
        .length,
    ).toBeGreaterThan(0);
  });

  it("donne une hauteur tactile d'au moins 44 px aux boutons du plafond", () => {
    renderPlanner();
    expect(
      screen.getByRole("button", { name: "Revenir aux hypothèses Immojudis" }).className,
    ).toContain("min-h-11");
    expect(screen.getByRole("button", { name: "Modifier les hypothèses" }).className).toContain(
      "min-h-11",
    );
    expect(screen.getByRole("button", { name: /^Plafond · / }).className).toContain("min-h-11");
  });
});

describe("CeilingPlanner : simulateur d'enchère", () => {
  const field = () => screen.getByLabelText(/Montant de l’enchère simulée/) as HTMLInputElement;

  it("accepte un champ vide pendant la saisie au lieu de le ramener à 0", () => {
    renderPlanner();
    expect(field().value).toBe("30000");
    fireEvent.change(field(), { target: { value: "" } });
    expect(field().value).toBe("");
    fireEvent.change(field(), { target: { value: "4" } });
    expect(field().value).toBe("4");
    fireEvent.change(field(), { target: { value: "45000" } });
    expect(field().value).toBe("45000");
  });

  it("calcule avec 0 € tant que le champ est vide, puis réaffiche le montant en quittant le champ", () => {
    renderPlanner();
    const simulator = screen
      .getByRole("heading", { name: "Si vous l’emportez à…" })
      .closest("section")!;
    const before = simulator.textContent;
    fireEvent.change(field(), { target: { value: "" } });
    expect(field().value).toBe("");
    expect(simulator.textContent).not.toBe(before);
    fireEvent.blur(field());
    expect(field().value).toBe("0");
  });

  it("un choix rapide remplace le texte en cours de saisie", () => {
    renderPlanner();
    fireEvent.change(field(), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /^Mise à prix · / }));
    expect(field().value).toBe("30000");
  });

  it("donne une cible de 44 px à « Choisir les travaux »", () => {
    renderPlanner({ onEditWorks: () => undefined });
    expect(screen.getByRole("button", { name: "Choisir les travaux" }).className).toContain(
      "min-h-11",
    );
  });
});
