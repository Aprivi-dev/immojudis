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
    // Le choix du visiteur est annoncé ; la démonstration automatique ne l'est pas.
    expect(verdictBox().getAttribute("aria-live")).toBe("polite");
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
