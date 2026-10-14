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
    expect(text).toContain("Les annonces ne sont ni avancées, ni reculées");
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
