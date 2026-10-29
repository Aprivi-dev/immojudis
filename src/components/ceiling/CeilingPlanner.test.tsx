// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { buildCeilingHypotheses, type CeilingUserChoices } from "@/lib/bid-ceiling-defaults";
import { computeCeilingPlan, type CeilingHypotheses } from "@/lib/bid-ceiling-engine";
import {
  NOTARY_AUCTION_FEE_REGIME,
  NOTARY_ONLINE_FEE_REGIME,
  TRIBUNAL_FEE_REGIME,
  type FeeRegime,
} from "@/lib/fee-regime";
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

describe("CeilingPlanner textes du régime de frais", () => {
  it("garde les textes du tribunal sans régime, et avec le régime tribunal", () => {
    for (const regime of [undefined, TRIBUNAL_FEE_REGIME]) {
      renderPlanner({ tweak: (built) => ({ ...built, regime }) });
      expect(screen.getByRole("heading", { name: "Votre enchère plafond" })).toBeTruthy();
      expect(screen.getByText(/^Le montant à ne pas dépasser à l’audience/)).toBeTruthy();
      expect(screen.getByText("Prix d’adjudication")).toBeTruthy();
      expect(screen.getByText("Émoluments de l’avocat poursuivant")).toBeTruthy();
      expect(screen.getByText("À vérifier avant l’audience")).toBeTruthy();
      cleanup();
    }
  });

  it("lit les textes du régime porté par les hypothèses", () => {
    const regime: FeeRegime = {
      ...TRIBUNAL_FEE_REGIME,
      labels: {
        ...TRIBUNAL_FEE_REGIME.labels,
        planner: {
          ...TRIBUNAL_FEE_REGIME.labels.planner,
          title: "Votre offre plafond",
          resultEyebrow: "Offre plafond (simulation)",
          priceLabel: "Prix d’adjudication notariale",
        },
      },
    };
    renderPlanner({ tweak: (built) => ({ ...built, regime }) });

    expect(screen.getByRole("heading", { name: "Votre offre plafond" })).toBeTruthy();
    expect(screen.getByText(/^Offre plafond \(simulation\) · /)).toBeTruthy();
    expect(screen.getByText("Prix d’adjudication notariale")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Votre enchère plafond" })).toBeNull();
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
      .closest("details")!;

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
      .closest("details")!;
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
      .closest("details")!;
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

describe("CeilingPlanner : ventes notariales", () => {
  const onlineSale = {
    ...sale,
    sale_venue_type: "notary",
    sale_conditions: {
      procedure: "online_tender",
      first_offer_eur: 30_000,
      negotiation_fee_rate: 0.045,
      negotiation_fee_payer: "ACQUEREUR",
      advertising_fees_eur: 1_200,
    },
  } as unknown as AuctionSale;
  const auctionSale = {
    ...sale,
    sale_venue_type: "notary",
    sale_conditions: { procedure: "notarial_auction", deposit_eur: 12_000, overbid_allowed: true },
  } as unknown as AuctionSale;

  function renderNotarial(item: AuctionSale, regime: FeeRegime, choices: CeilingUserChoices = {}) {
    const hypotheses = buildCeilingHypotheses(item, estimate, choices, regime);
    return render(
      <CeilingPlanner
        hypotheses={hypotheses}
        plan={computeCeilingPlan(hypotheses)}
        choices={choices}
        onChoicesChange={() => undefined}
        onReset={() => undefined}
      />,
    );
  }

  it("écrit « offre plafond », la première offre possible et la mention du vendeur pour la vente interactive", () => {
    renderNotarial(onlineSale, NOTARY_ONLINE_FEE_REGIME);

    expect(screen.getByRole("heading", { name: "Votre offre plafond" })).toBeTruthy();
    expect(screen.getByText(/^Offre plafond \(simulation\) · /)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Si votre offre est retenue à…" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "À vérifier avant votre offre" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Première offre possible · / })).toBeTruthy();
    // Mention obligatoire, dans le verdict et dans la liste de vérifications.
    expect(
      screen.getAllByText(
        "Le vendeur n’est pas tenu de retenir la meilleure offre ; prix de réserve inconnu.",
      ).length,
    ).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/Hors débours et formalités du notaire/).length).toBeGreaterThan(0);
    // Ni enchère ni adjudication dans les titres, les étapes et le calendrier.
    const headings = screen.getAllByRole("heading").map((node) => node.textContent ?? "");
    expect(headings.join(" | ")).not.toMatch(/ench[èe]re|adjudication/i);
    const steps = within(document.getElementById("why-this-ceiling")!).getAllByRole("listitem");
    expect(steps.map((step) => step.textContent).join(" | ")).not.toMatch(
      /ench[èe]re|adjudication/i,
    );
    const cash = within(
      screen.getByRole("heading", { name: "Trésorerie à prévoir" }).closest("details")!,
    );
    expect(cash.getByText("Avant-contrat")).toBeTruthy();
    expect(cash.queryByText(/surenchère|Honoraires de votre avocat|Garantie/)).toBeNull();
    expect(cash.getByText(/^Pour une offre retenue à /)).toBeTruthy();
  });

  it("garde « enchère plafond » et la garantie pour la vente à la bougie, sans avocat ni frais préalables", () => {
    renderNotarial(auctionSale, NOTARY_AUCTION_FEE_REGIME);

    expect(screen.getByRole("heading", { name: "Votre enchère plafond" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "À vérifier avant la vente" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Mise à prix · / })).toBeTruthy();
    const cash = within(
      screen.getByRole("heading", { name: "Trésorerie à prévoir" }).closest("details")!,
    );
    expect(cash.getByText("Garantie à déposer")).toBeTruthy();
    expect(cash.getByText("Fin du délai de surenchère")).toBeTruthy();
    expect(cash.getByText("Solde du prix, droits et frais")).toBeTruthy();
    expect(cash.queryByText(/Honoraires de votre avocat|Frais préalables/)).toBeNull();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/avocat poursuivant|R\. ?322|sous 2 mois/);
    expect(text).toContain("Frais d’organisation et de publicité");
  });

  it("signale « Frais estimés, à confirmer » avec l'icône et le texte, jamais la couleur seule", () => {
    renderNotarial(
      {
        ...onlineSale,
        sale_conditions: { procedure: "online_tender", first_offer_eur: 30_000 },
      } as never,
      NOTARY_ONLINE_FEE_REGIME,
    );
    const badge = screen.getByText("Frais estimés, à confirmer");
    expect(badge.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(badge.parentElement?.textContent).toContain("honoraires de négociation");
    cleanup();
    // Les honoraires lus dans l'annonce : plus de pastille.
    renderNotarial(onlineSale, NOTARY_ONLINE_FEE_REGIME);
    expect(screen.queryByText("Frais estimés, à confirmer")).toBeNull();
  });

  it("signale les frais préalables par défaut au tribunal, et plus une fois saisis", () => {
    renderPlanner();
    const badge = screen.getByText("Frais estimés, à confirmer");
    expect(badge.parentElement?.textContent).toContain("frais préalables");
    cleanup();
    renderPlanner({ choices: { fpt: 4_000 } });
    expect(screen.queryByText("Frais estimés, à confirmer")).toBeNull();
  });

  it("écrit la sensibilité aux frais : +1 000 € de frais = −X € d'enchère (ou d'offre) plafond", () => {
    renderPlanner();
    const tribunal = screen.getByTestId("fee-sensitivity").textContent ?? "";
    expect(tribunal).toMatch(/^\+1 000 € de frais = −[\d\s\u202f\u00a0]+€ d’enchère plafond/);
    expect(tribunal).toContain("ce n’est pas une fourchette");
    cleanup();
    renderNotarial(onlineSale, NOTARY_ONLINE_FEE_REGIME);
    expect(screen.getByTestId("fee-sensitivity").textContent).toMatch(
      /^\+1 000 € de frais = −[\d\s\u202f\u00a0]+€ d’offre plafond/,
    );
  });
});

describe("CeilingPlanner : rendement d'un loyer ANIL", () => {
  // 2 EUR/m2 : le loyer est le seul à limiter le plafond du projet « louer ».
  const lowAnil = {
    rentPerM2: 2,
    source: "anil_commune" as const,
    reliability: "reliable" as const,
    segment: "apt_all" as const,
    communeCode: "34172",
    lowPerM2: null,
    highPerM2: null,
    observations: 900,
    vintage: 2025,
    sourceUpdatedOn: "2025-12-11",
  };
  const withAnil = (choices: CeilingUserChoices) =>
    renderPlanner({
      choices,
      tweak: () => buildCeilingHypotheses(sale, estimate, choices, null, lowAnil),
    });

  it("parle d'un rendement brut, charges comprises, tant que les charges récupérables sont vides", () => {
    withAnil({ project: "louer" });

    expect(document.body.textContent).toMatch(
      /c’est le loyer qui limite le plafond \(rendement brut visé [\d.,]+ %, charges comprises\)/,
    );
    expect(document.body.textContent).not.toMatch(/rendement net visé/);
  });

  it("revient à « net » dès que les charges récupérables sont saisies", () => {
    withAnil({ project: "louer", recoverableCharges: 10 });

    expect(document.body.textContent).toMatch(/rendement net visé [\d.,]+ %\)/);
    expect(document.body.textContent).not.toMatch(/charges comprises\)/);
  });
});

describe("CeilingPlanner accessibilité", () => {
  function renderWithChoices(market: MarketEstimate | null = estimate) {
    const calls: CeilingUserChoices[] = [];
    const hypotheses = buildCeilingHypotheses(sale, market, {});
    render(
      <CeilingPlanner
        hypotheses={hypotheses}
        plan={computeCeilingPlan(hypotheses)}
        choices={{}}
        onChoicesChange={(change) => calls.push(change({}))}
        onReset={() => undefined}
      />,
    );
    return calls;
  }

  it("n'a qu'un arrêt de Tab par groupe de radios, sur le choix coché", () => {
    renderWithChoices();
    for (const name of ["Votre projet", "Niveau de prudence"]) {
      const radios = within(screen.getByRole("radiogroup", { name })).getAllByRole("radio");
      const stops = radios.filter((radio) => radio.getAttribute("tabindex") === "0");
      expect(stops).toHaveLength(1);
      expect(stops[0].getAttribute("aria-checked")).toBe("true");
    }
  });

  it("change de projet et de prudence avec les flèches, Début et Fin", () => {
    const calls = renderWithChoices();
    const projects = within(screen.getByRole("radiogroup", { name: "Votre projet" })).getAllByRole(
      "radio",
    );
    const current = projects.findIndex((radio) => radio.getAttribute("aria-checked") === "true");
    fireEvent.keyDown(projects[current], { key: "ArrowRight" });
    expect(document.activeElement).toBe(projects[(current + 1) % projects.length]);
    expect(calls.at(-1)?.project).toBeTruthy();

    const profiles = within(
      screen.getByRole("radiogroup", { name: "Niveau de prudence" }),
    ).getAllByRole("radio");
    fireEvent.keyDown(profiles[0], { key: "End" });
    expect(document.activeElement).toBe(profiles[profiles.length - 1]);
    fireEvent.keyDown(profiles[profiles.length - 1], { key: "ArrowRight" });
    expect(document.activeElement).toBe(profiles[0]);
    expect(calls.at(-1)?.customMarginPct).toBeNull();
  });

  it("relie le bouton des hypothèses à son panneau", () => {
    renderWithChoices();
    const toggle = screen.getByRole("button", { name: "Modifier les hypothèses" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    const open = screen.getByRole("button", { name: "Masquer les hypothèses" });
    expect(open.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(open.getAttribute("aria-controls") ?? "")).not.toBeNull();
  });

  it("n'offre pas « Masquer les hypothèses » quand le plan est indisponible", () => {
    renderWithChoices(null);
    expect(screen.queryByRole("button", { name: /hypothèses$/ })).toBeNull();
    // Les champs restent ouverts pour compléter le calcul.
    expect(screen.getByLabelText(/^Prix au m² du bien/)).toBeTruthy();
  });
});
