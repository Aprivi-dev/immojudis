// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { exampleVerdictData } from "@/lib/example-verdict";
import { HomeTryExample } from "./HomeTryExample";

afterEach(cleanup);

const text = (element: Element) => (element.textContent ?? "").replace(/\s/g, " ");

function verdictBox() {
  return screen.getByText("Votre enchère plafond").closest("div")!.parentElement!;
}

describe("Essayez sur un exemple", () => {
  it("montre d'abord la situation de /annonce-exemple, avec les données croisées", () => {
    render(<HomeTryExample data={exampleVerdictData()} />);
    expect(text(verdictBox())).toContain("135 000 €");
    expect(text(verdictBox())).toContain("On enchérit");
    expect(text(verdictBox())).toContain("Occupé : 3 000 € et 12 mois pour libérer le bien.");
    // La démonstration qui défile seule n'est pas annoncée : la zone ne l'est qu'après un choix.
    expect(within(verdictBox()).queryByRole("status")).toBeNull();
    const card = screen.getByRole("group", { name: /simulateur du verdict/ });
    expect(text(card)).toContain("12 ventes à moins de 100 m");
    expect(text(card)).toContain("Même immeuble : 226 000 €");
    expect(text(card)).toContain("Occupant déclaré, bail non produit (PV p. 3)");
    expect(within(card).getByRole("button", { name: "Habiter" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("recalcule le plafond et passe au rouge quand la mise à prix le dépasse", () => {
    render(<HomeTryExample data={exampleVerdictData()} />);
    fireEvent.click(screen.getByRole("button", { name: "Louer" }));
    fireEvent.click(screen.getByRole("button", { name: "Rénovation confort" }));
    expect(screen.getByRole("button", { name: "Louer" }).getAttribute("aria-pressed")).toBe("true");
    expect(text(verdictBox())).toContain("On passe son tour");
    expect(text(verdictBox())).toContain("La mise à prix dépasse déjà votre plafond de 50 500 €.");
    expect(text(verdictBox())).toContain("Louer : le loyer estimé fixe la limite (rendement).");
    // Après un choix, la zone annoncée porte la valeur finale ; le montant animé est masqué.
    const status = within(verdictBox()).getByRole("status");
    expect(text(status)).toContain("Votre enchère plafond : 44 500 €. On passe son tour.");
    expect(verdictBox().querySelector("[aria-live]")).toBeNull();
    expect(verdictBox().querySelector('p[aria-hidden="true"]')).not.toBeNull();
  });

  it("compte les données à confirmer et définit la mise à prix", () => {
    render(<HomeTryExample data={exampleVerdictData()} />);
    expect(text(document.body)).toContain("8 données croisées, 1 à confirmer");
    expect(text(document.body)).not.toContain("sources citées");
    expect(text(document.body)).toContain(
      "La mise à prix est le montant à partir duquel démarrent les enchères ; ce n’est pas le prix final.",
    );
  });

  it("renvoie vers l'analyse complète depuis la carte et ancre #essayer sous l'en-tête flottant", () => {
    render(<HomeTryExample data={exampleVerdictData()} />);
    const card = screen.getByRole("group", { name: /simulateur du verdict/ });
    expect(
      within(card)
        .getByRole("link", { name: /Voir l’analyse complète/ })
        .getAttribute("href"),
    ).toBe("/annonce-exemple");
    expect(document.getElementById("essayer")?.className).toMatch(/tryAnchor/);
  });

  it("n'a qu'un bouton de pause, qui reste pressé jusqu'à reprise", () => {
    render(<HomeTryExample data={exampleVerdictData()} />);
    const pause = screen.getByRole("button", { name: "Mettre en pause l’animation" });
    expect(pause.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(pause);
    expect(pause.getAttribute("aria-pressed")).toBe("true");
  });

  it("énonce la règle des trois verdicts et renvoie vers l'exemple complet", () => {
    render(<HomeTryExample data={exampleVerdictData()} />);
    expect(text(document.body)).toContain(
      "On enchérit quand le plafond dépasse la mise à prix d’au moins 10 %.",
    );
    expect(text(document.body)).toContain("Serré quand la marge est de moins de 10 %.");
    expect(
      screen
        .getByRole("link", { name: /Voir l’analyse complète de l’exemple/ })
        .getAttribute("href"),
    ).toBe("/annonce-exemple");
  });
});
