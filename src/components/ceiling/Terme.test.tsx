// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { axe } from "vitest-axe";
import { afterEach, describe, expect, it } from "vitest";
import { Terme } from "./Terme";

afterEach(cleanup);

describe("Terme", () => {
  it("shows the word and a help button that opens a short definition", () => {
    render(
      <p>
        <Terme terme="surenchere">surenchère</Terme>
      </p>,
    );
    const button = screen.getByRole("button", { name: "Définition : surenchère" });

    expect(screen.getByText("surenchère")).toBeTruthy();
    expect(screen.queryByRole("note")).toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(button);

    const note = screen.getByRole("note");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.getAttribute("aria-controls")).toBe(note.id);
    expect(note.textContent).toContain("Offre formée après une adjudication");
    expect(screen.getByRole("link", { name: "En savoir plus" }).getAttribute("href")).toBe(
      "/ventes-immobilieres-judiciaires#lexique-surenchere",
    );
  });

  it("closes on Escape, giving the focus back to the button", () => {
    render(<Terme terme="portage" />);
    const button = screen.getByRole("button", { name: "Définition : portage" });

    fireEvent.click(button);
    expect(screen.getByRole("note")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("note")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("closes on a click outside, and toggles with the button", () => {
    render(
      <div>
        <Terme terme="liberation" />
        <span>ailleurs</span>
      </div>,
    );
    const button = screen.getByRole("button", { name: "Définition : libération du bien" });

    fireEvent.click(button);
    expect(screen.getByRole("note")).toBeTruthy();
    fireEvent.pointerDown(screen.getByText("ailleurs"));
    expect(screen.queryByRole("note")).toBeNull();

    fireEvent.click(button);
    fireEvent.click(button);
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("has no structural accessibility violation, open or closed", async () => {
    const { container } = render(
      <p>
        <Terme terme="emoluments">émoluments</Terme>
      </p>,
    );
    expect(
      (await axe(container, { rules: { "color-contrast": { enabled: false } } })).violations,
    ).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Définition : émoluments" }));
    expect(
      (await axe(container, { rules: { "color-contrast": { enabled: false } } })).violations,
    ).toEqual([]);
  });
});

describe("Terme : glossaire et zone d'appui", () => {
  it.each([
    [
      "garantie-encherir",
      "garantie pour enchérir",
      "caution bancaire irrévocable remis à l’avocat avant les enchères (en saisie immobilière : 10 % de la mise à prix, 3 000 € au minimum)",
      "lexique-garantie-pour-encherir",
    ],
    [
      "frais-prealables",
      "frais préalables",
      "montant a été fixé (taxé) par le juge. Ils sont à la charge de l’adjudicataire, en plus du prix",
      "lexique",
    ],
    ["proces-verbal-descriptif", "procès-verbal descriptif", "commissaire de justice", "lexique"],
    [
      "cahier-conditions-vente",
      "cahier des conditions de vente",
      "rédigé par l’avocat du créancier poursuivant",
      "lexique-cahier-des-conditions-de-vente",
    ],
    ["droit-preemption", "droit de préemption", "se substituer à l’adjudicataire", "lexique"],
    [
      "consignation",
      "consignation du prix",
      "Dépôt du prix de l’adjudication sur un compte séquestre",
      "lexique-consignation-du-prix",
    ],
    [
      "enchere-plafond",
      "enchère plafond",
      "Montant maximum à ne pas dépasser",
      "lexique-enchere-plafond",
    ],
    [
      "mise-a-prix",
      "mise à prix",
      "Prix de départ de la vente aux enchères",
      "lexique-mise-a-prix",
    ],
    ["portage", "portage", "Ce que coûte le bien", "lexique-portage"],
    ["emoluments", "émoluments", "barème réglementé", "lexique-emoluments"],
  ] as const)("définit « %s » avec un texte court et neutre", (terme, label, extrait, ancre) => {
    render(<Terme terme={terme} />);
    expect(screen.getByText(label)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: `Définition : ${label}` }));
    const note = screen.getByRole("note");
    expect(note.textContent).toContain(extrait);
    expect(note.textContent).not.toMatch(/conseill|recommand|mieux vaut/i);
    expect(screen.getByRole("link", { name: "En savoir plus" }).getAttribute("href")).toBe(
      `/ventes-immobilieres-judiciaires#${ancre}`,
    );
  });

  it("peut n'afficher que le bouton quand le mot est écrit à côté", () => {
    render(
      <h3>
        Une enchère plafond chiffrée <Terme terme="enchere-plafond" bare />
      </h3>,
    );
    expect(screen.getAllByText(/enchère plafond/i)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Définition : enchère plafond" })).toBeTruthy();
  });

  it("relie le bouton à sa bulle (aria-controls) même fermée", () => {
    render(<Terme terme="adjudication" />);
    const button = screen.getByRole("button", { name: "Définition : adjudication" });
    expect(button.getAttribute("aria-controls")).toBeTruthy();
    fireEvent.click(button);
    expect(screen.getByRole("note").id).toBe(button.getAttribute("aria-controls"));
  });

  it("garde l'icône à 16 px mais une zone d'appui de 44 px", () => {
    render(<Terme terme="portage" />);
    const button = screen.getByRole("button", { name: "Définition : portage" });
    expect(button.className).toContain("h-6");
    expect(button.className).toContain("w-6");
    expect(button.className).toContain("after:-inset-2.5");
    expect(button.className).toContain("relative");
    expect(button.querySelector("svg")?.getAttribute("class")).toContain("h-4 w-4");
  });

  it('ouvre la bulle au-dessus du mot avec placement="top"', () => {
    render(<Terme terme="portage" placement="top" />);
    fireEvent.click(screen.getByRole("button", { name: "Définition : portage" }));
    expect(screen.getByRole("note").className).toContain("bottom-full");
    cleanup();
    render(<Terme terme="portage" />);
    fireEvent.click(screen.getByRole("button", { name: "Définition : portage" }));
    expect(screen.getByRole("note").className).toContain("top-full");
  });
});
