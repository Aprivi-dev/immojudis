// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import Page, { metadata } from "./page";

afterEach(cleanup);

describe("page Déclaration d'accessibilité", () => {
  it("annonce l'état « non évalué » sans prétendre à une conformité", () => {
    const { container } = render(<Page />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Déclaration d’accessibilité",
    );
    expect(
      screen.getByRole("heading", { level: 2, name: "État de conformité : non évalué" }),
    ).toBeDefined();
    const text = container.textContent ?? "";
    expect(text).toContain("Aucun audit complet n’a été réalisé à ce jour");
    expect(text).toContain("RGAA");
    expect(text).not.toMatch(/est conforme au RGAA|totalement conforme|partiellement conforme à/i);
  });

  it("liste les contenus connus non accessibles : bordures, focus, galerie", () => {
    render(<Page />);
    const section = screen
      .getByRole("heading", {
        level: 2,
        name: "Contenus que nous savons non accessibles",
      })
      .closest("section")!;
    const titles = within(section)
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent);
    expect(titles).toEqual([
      "Contraste des bordures de certains champs",
      "Contraste de l’indicateur de focus au clavier",
      "Galerie de photos",
      "Contenus non évalués",
    ]);
    expect(section.textContent).toContain("Leur correction est en cours");
  });

  it("donne un moyen de contact et les voies de recours auprès du Défenseur des droits", () => {
    render(<Page />);
    const contact = screen
      .getByRole("heading", {
        level: 2,
        name: "Signaler un défaut ou demander une alternative",
      })
      .closest("section")!;
    expect(within(contact).getByRole("link", { name: "page Contact" }).getAttribute("href")).toBe(
      "/contact",
    );
    const recours = screen
      .getByRole("heading", { level: 2, name: "Voies de recours" })
      .closest("section")!;
    expect(recours.textContent).toContain("Défenseur des droits");
    expect(recours.textContent).toContain("Libre réponse 71120, 75342 Paris CEDEX 07");
    expect(
      within(recours)
        .getAllByRole("link")
        .every((link) =>
          link.getAttribute("href")?.startsWith("https://www.defenseurdesdroits.fr/"),
        ),
    ).toBe(true);
  });

  it("porte un titre et une description de page", () => {
    expect(String(metadata.title)).toContain("Déclaration d’accessibilité");
    expect(String(metadata.description).length).toBeGreaterThan(50);
  });

  it("laisse l’adresse longue des références passer à la ligne (aucun défilement horizontal à 320 px)", () => {
    render(<Page />);
    const link = screen.getByRole("link", { name: /accessibilite\.numerique\.gouv\.fr/ });
    expect(link.className).toContain("wrap-anywhere");
  });
});
