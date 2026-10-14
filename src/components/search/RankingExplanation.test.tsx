// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  RANKING_EXPLANATION_INVESTMENT_NOTE,
  RANKING_EXPLANATION_NOTES,
  RANKING_EXPLANATION_STEPS,
  RANKING_EXPLANATION_TITLE,
  RankingExplanation,
} from "./RankingExplanation";

afterEach(cleanup);

describe("RankingExplanation", () => {
  it("propose le lien « Comment sont classées les annonces ? », replié par défaut", () => {
    const { container } = render(<RankingExplanation />);
    expect(screen.getByText("Comment sont classées les annonces ?")).toBeTruthy();
    expect(RANKING_EXPLANATION_TITLE).toBe("Comment sont classées les annonces ?");
    const details = container.querySelector("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe(RANKING_EXPLANATION_TITLE);
  });

  it("liste les trois critères dans l'ordre réel de priorité", () => {
    const { container } = render(<RankingExplanation />);
    expect(screen.getByText(/classées selon trois critères, dans cet ordre/)).toBeTruthy();
    const items = [...container.querySelectorAll("ol > li")].map((item) => item.textContent);
    expect(items).toEqual([...RANKING_EXPLANATION_STEPS]);
    // 1. position sur la carte, 2. quantité d'informations de la fiche, 3. date de vente.
    expect(items[0]).toContain("position sur la carte est connue passent avant les autres");
    expect(items[1]).toContain("deux groupes selon la quantité d’informations");
    expect(items[1]).toContain(
      "« bien renseignées » (score de complétude d’au moins 40 sur 100) vient en premier",
    );
    expect(items[1]).not.toContain("décision prête");
    expect(items[2]).toContain("la vente la plus proche est affichée en premier");
  });

  it("précise l'absence de rémunération, l'encart d'avocats et la portée du repère", () => {
    render(<RankingExplanation />);
    const notes = RANKING_EXPLANATION_NOTES.join(" ");
    expect(notes).toContain("Il ne dépend d’aucune rémunération");
    expect(notes).toContain("personne ne peut payer pour améliorer le rang d’une annonce");
    expect(notes).toContain("mise en avant payante");
    expect(notes).toContain("ne garantit ni l’exactitude des informations ni l’état du bien");
    expect(notes).toContain("trier par date, prix ou surface");
    expect(notes).not.toContain("Quel que soit le tri");
    for (const note of RANKING_EXPLANATION_NOTES) expect(screen.getByText(note)).toBeTruthy();
  });

  it("renvoie vers la page publique du classement avec « En savoir plus »", () => {
    render(<RankingExplanation />);
    expect(screen.getByRole("link", { name: "En savoir plus" }).getAttribute("href")).toBe(
      "/classement-des-annonces",
    );
  });

  it("n'ajoute la mention du score d'investissement que pour l'offre Analyse", () => {
    render(<RankingExplanation />);
    expect(screen.queryByText(RANKING_EXPLANATION_INVESTMENT_NOTE)).toBeNull();
    cleanup();
    render(<RankingExplanation investmentScore />);
    expect(screen.getByText(RANKING_EXPLANATION_INVESTMENT_NOTE)).toBeTruthy();
    expect(RANKING_EXPLANATION_INVESTMENT_NOTE).toContain("sans promesse de rendement");
  });
});
