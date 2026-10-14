// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Page, { metadata } from "./page";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_LEGAL_CONTACT_EMAIL", "contact@immojudis.example");
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("page « Comment sont classées les annonces ? »", () => {
  it("a son adresse canonique, un titre court et une description sobre", () => {
    expect(metadata.alternates?.canonical).toBe("/classement-des-annonces");
    expect(String(metadata.title).length + " - Immojudis".length).toBeLessThanOrEqual(60);
    const description = String(metadata.description);
    expect(description.length).toBeGreaterThanOrEqual(90);
    expect(description.length).toBeLessThanOrEqual(170);
  });

  it("porte le contenu principal #contenu et un seul titre de niveau 1", () => {
    const { container } = render(<Page />);
    expect(container.querySelector("main#contenu")).not.toBeNull();
    const titles = screen.getAllByRole("heading", { level: 1 });
    expect(titles.map((title) => title.textContent)).toEqual([
      "Comment sont classées les annonces ?",
    ]);
  });

  it("décrit les trois critères du classement par défaut dans l'ordre réel", () => {
    render(<Page />);
    const section = screen.getByRole("region", {
      name: "Le classement par défaut : « Mieux renseignées d’abord »",
    });
    const items = within(section)
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(items).toHaveLength(3);
    expect(items[0]).toContain("position sur la carte est connue passent avant les autres");
    expect(items[1]).toContain("deux groupes selon la quantité d’informations");
    expect(items[2]).toContain("la vente la plus proche est affichée en premier");
    expect(items[1]).toContain("score de complétude d’au moins 40 sur 100");
    expect(section.textContent).toContain(
      "Le score de complétude mesure, sur 100, la part des informations utiles renseignées dans la fiche Immojudis, appuyées par une source ; il ne juge ni l’intérêt ni la valeur du bien.",
    );
    expect(section.textContent).not.toContain("décision prête");
    expect(section.textContent).toContain("Il ne dépend d’aucune rémunération");
    expect(section.textContent).toContain("évaluée dans les heures qui suivent");
  });

  it("liste les tris au choix, dont le score d'investissement réservé à Analyse", () => {
    render(<Page />);
    const section = screen.getByRole("region", { name: "Les autres tris" });
    const text = section.textContent ?? "";
    for (const sort of ["Date de vente", "Prix", "Surface", "chambres", "Distance"]) {
      expect(text).toContain(sort);
    }
    expect(text).toContain("Score d’investissement, pour l’offre Analyse seulement.");
    expect(text).toContain("estimation indicative, sans promesse de rendement ni conseil");
    expect(text).not.toContain("Quel que soit le tri");
  });

  it("décrit le comportement exact de chaque tri, y compris « chambres » et « distance »", () => {
    render(<Page />);
    const text = screen.getByRole("region", { name: "Les autres tris" }).textContent ?? "";
    expect(text).toContain(
      "Pour les tris par date, prix, surface et score d’investissement, les annonces dont la position sur la carte est connue sont affichées avant les autres ; le critère choisi les ordonne ensuite, et les annonces auxquelles l’information manque viennent en dernier.",
    );
    expect(text).toContain("Nombre de chambres : les pages de résultats sont constituées");
    expect(text).toContain(
      "dans chaque page, les annonces sont rangées de celles qui comptent le plus de chambres",
    );
    expect(text).toContain("à égalité, l’ordre de la page est conservé");
    expect(text).toContain(
      "Distance, à partir d’une adresse que vous saisissez : les annonces les plus proches de cette adresse d’abord ; celles dont la position est inconnue viennent en dernier.",
    );
  });

  it("dit que les professionnels validés peuvent transmettre une annonce, contrôlée, sans priorité", () => {
    render(<Page />);
    const origin = screen.getByRole("region", { name: "D’où viennent les annonces ?" });
    expect(origin.textContent).toContain(
      "Les professionnels (avocats, notaires, commissaires de justice, tribunaux) disposant d’un compte professionnel validé peuvent aussi transmettre une annonce. Elle est contrôlée par l’équipe avant publication. Cette transmission ne donne aucune priorité de classement à l’annonce.",
    );
  });

  it("énonce les motifs de retrait réellement appliqués", () => {
    render(<Page />);
    const end = screen.getByRole("region", {
      name: "Quand une annonce n’est-elle plus affichée ?",
    });
    expect(end.textContent).toContain("retirée par sa source");
    expect(end.textContent).toContain(
      "retirée du catalogue lorsque l’équipe constate une erreur de publication ou une information inexacte",
    );
  });

  it("explique que le repère « bien renseignée » mesure la quantité, pas l'exactitude", () => {
    render(<Page />);
    const section = screen.getByRole("region", { name: "Le repère « Annonce bien renseignée »" });
    expect(section.textContent).toContain("pas leur exactitude");
    expect(section.textContent).toContain("ni vérification ni garantie sur le bien");
  });

  it("présente l'encart « Publicité · Sponsorisé » des avocats comme payé, sans effet sur l'ordre", () => {
    render(<Page />);
    const section = screen.getByRole("region", { name: /Publicité · Sponsorisé/ });
    const text = section.textContent ?? "";
    expect(text).toContain("le cabinet paie Immojudis");
    expect(text).toContain("zone géographique");
    expect(text).toContain(
      "C’est une publicité : le cabinet paie Immojudis, ou bénéficie d’un essai gratuit de cette offre payante, pour être présenté dans la zone géographique de votre recherche.",
    );
    expect(text).toContain(
      "Cet encart n’est ni une recommandation, ni une notation, ni une garantie de résultat. Les annonces ne sont ni avancées ni reculées par cet encart.",
    );
    expect(text).not.toContain("apparaître ici");
    expect(
      within(section)
        .getByRole("link", { name: "Comment sont classés les avocats ?" })
        .getAttribute("href"),
    ).toBe("/avocats#lawyer-ranking-title");
  });

  it("dit d'où viennent les annonces, quand elles disparaissent et comment signaler une erreur", () => {
    render(<Page />);
    const origin = screen.getByRole("region", { name: "D’où viennent les annonces ?" });
    expect(origin.textContent).toContain("ne garantit pas leur exactitude");
    const end = screen.getByRole("region", {
      name: "Quand une annonce n’est-elle plus affichée ?",
    });
    expect(end.textContent).toContain("minuit (heure de Paris)");
    expect(end.textContent).toContain("adjugée, annulée ou retirée");
    const report = screen.getByRole("region", { name: "Signaler une erreur" });
    expect(within(report).getByRole("link", { name: "Contact" }).getAttribute("href")).toBe(
      "/contact",
    );
    expect(
      within(report).getByRole("link", { name: "contact@immojudis.example" }).getAttribute("href"),
    ).toBe("mailto:contact@immojudis.example");
    expect(
      within(report).getByRole("link", { name: "conditions générales" }).getAttribute("href"),
    ).toBe("/conditions-generales");
  });
});
