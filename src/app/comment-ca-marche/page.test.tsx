// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import Page from "./page";

afterEach(cleanup);

describe("page Comment ça marche", () => {
  it("présente quatre étapes illustrées dans l'ordre attendu", () => {
    render(<Page />);
    const steps = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(steps).toHaveLength(4);
    const titles = steps.map((step) => within(step).getByRole("heading", { level: 2 }).textContent);
    expect(titles).toEqual([
      "Étape 1 : Repérer une vente",
      "Étape 2 : Étudier et visiter",
      "Étape 3 : Fixer son enchère plafond",
      "Étape 4 : Enchérir et finaliser",
    ]);
  });

  it("renvoie l'étape budget vers le simulateur de frais", () => {
    render(<Page />);
    const step = within(screen.getByRole("list")).getAllByRole("listitem")[2]!;
    expect(within(step).getByRole("link", { name: "Simuler les frais" }).getAttribute("href")).toBe(
      "/simulateur-frais-encheres",
    );
  });

  it("décrit l'annuaire et la mise en relation avec le vocabulaire de la mise en avant payante", () => {
    const { container } = render(<Page />);
    const text = container.textContent ?? "";
    expect(text).toContain(
      "La consultation de l’annuaire est gratuite. Certains avocats rémunèrent Immojudis pour une mise en avant payante. La demande de mise en relation depuis une annonce fait partie de l’offre Analyse.",
    );
    expect(text).not.toMatch(/sponsoris/i);
  });

  it("ne dit plus que l'enchère plafond est réservée à Analyse : le compte gratuit l'ouvre sur 3 ventes au tribunal", () => {
    const { container } = render(<Page />);
    const step = within(screen.getByRole("list")).getAllByRole("listitem")[2]!;
    const text = step.textContent ?? "";
    expect(text).toContain(
      "Le compte gratuit l’ouvre sur 3 ventes au tribunal par mois (déblocages) ; l’offre Analyse l’ouvre sur toutes les ventes au tribunal.",
    );
    expect(text).not.toContain("Avec l’offre Analyse, le simulateur chiffre");
    expect(container.textContent).not.toMatch(/se fixe avec l’offre Analyse/);
  });

  it("ne montre pas la mention de l'offre de lancement tant que son état n'est pas lu", () => {
    render(<Page />);
    expect(screen.queryByTestId("launch-offer-note")).toBeNull();
  });

  it("ne mentionne plus les limites internes du produit", () => {
    const { container } = render(<Page />);
    expect(container.textContent).not.toMatch(
      /sauvegarde du simulateur|locale au navigateur|n’est pas encore détaillé|apport, le taux|Premium|ventes suivies/i,
    );
  });
});
