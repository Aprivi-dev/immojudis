// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import Page from "./page";

afterEach(cleanup);

describe("page Comment ça marche", () => {
  it("présente trois étapes, comme l'accueil, dans l'ordre attendu", () => {
    render(<Page />);
    const steps = within(screen.getByRole("list", { name: "Les trois étapes" })).getAllByRole(
      "listitem",
    );
    expect(steps).toHaveLength(3);
    const titles = steps.map((step) => within(step).getByRole("heading", { level: 2 }).textContent);
    expect(titles).toEqual([
      "Étape 1 : Créez votre compte gratuit",
      "Étape 2 : Repérez vos ventes",
      "Étape 3 : Fixez votre plafond",
    ]);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "De l’annonce à l’audience, en trois étapes",
    );
  });

  it("renvoie l'étape du plafond vers le simulateur de frais", () => {
    render(<Page />);
    const step = within(screen.getByRole("list", { name: "Les trois étapes" })).getAllByRole(
      "listitem",
    )[2]!;
    expect(within(step).getByRole("link", { name: "Simuler les frais" }).getAttribute("href")).toBe(
      "/simulateur-frais-encheres",
    );
  });

  it("garde un encadré « Ce qui surprend les débutants » : garantie, frais, prêt, surenchère, avec leur guide", () => {
    render(<Page />);
    const section = screen
      .getByRole("heading", { name: "Ce qui surprend les débutants" })
      .closest("section")!;
    const items = within(section).getAllByRole("listitem");
    expect(
      items.map((item) => within(item).getByRole("heading", { level: 3 }).textContent),
    ).toEqual([
      "Une garantie à remettre avant l’audience",
      "Des frais en plus du prix",
      "Pas de condition suspensive de prêt",
      "Une surenchère possible pendant dix jours",
    ]);
    expect(section.textContent).toContain("10 % de la mise à prix, avec un minimum de 3 000 €");
    expect(section.textContent).toContain("au moins un dixième du prix principal");
    const hrefs = within(section)
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    expect(hrefs).toEqual([
      "/ressources/garantie-10-pourcent-cheque-banque-caution-encheres",
      "/ressources/frais-vente-encheres-judiciaire",
      "/ressources/financer-achat-encheres-pret-delais",
      "/ressources/apres-adjudication-surenchere-paiement-titre-vente",
    ]);
  });

  it("range la mention commerciale sur les avocats dans une note distincte, hors des étapes", () => {
    render(<Page />);
    const note = screen.getByTestId("note-annuaire-avocats");
    expect(note.textContent).toContain(
      "La consultation de l’annuaire est gratuite. Certains avocats rémunèrent Immojudis pour une mise en avant payante, signalée comme telle. La demande de mise en relation depuis une annonce fait partie de l’offre Analyse.",
    );
    const steps = screen.getByRole("list", { name: "Les trois étapes" });
    expect(steps.textContent).not.toContain("rémunèrent Immojudis");
    expect(document.body.textContent).not.toMatch(/sponsoris/i);
  });

  it("ne dit plus que l'enchère plafond est réservée à Analyse : le compte gratuit l'ouvre sur 3 ventes au tribunal", () => {
    const { container } = render(<Page />);
    const step = within(screen.getByRole("list", { name: "Les trois étapes" })).getAllByRole(
      "listitem",
    )[2]!;
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
