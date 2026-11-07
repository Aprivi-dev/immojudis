// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FORCED_COLORS_SELECTED } from "./forced-colors";
import { MobileFilterChips } from "./MobileFilterChips";
import { SaleTypeFilter } from "./SaleTypeFilter";
import { ResultsViewToggle } from "./SearchHeader";
import { emptySearchDraft } from "./search-page-state";

vi.mock("./DateRangeFields", () => ({ DateRangeFields: () => null }));

afterEach(cleanup);

const selectedClasses = FORCED_COLORS_SELECTED.split(" ");

/** Le bouton choisi, et lui seul, se remplit de la couleur de sélection du système en contraste élevé. */
function expectOnlyPressedHighlighted(buttons: HTMLElement[]) {
  const pressed = buttons.filter((button) => button.getAttribute("aria-pressed") === "true");
  expect(pressed).toHaveLength(1);
  for (const button of buttons) {
    const classes = button.className.split(/\s+/);
    const highlighted = selectedClasses.every((name) => classes.includes(name));
    expect(highlighted, button.textContent ?? "").toBe(pressed.includes(button));
  }
}

describe("contraste élevé : états choisis de /sales", () => {
  it("remplit la classe de sélection du système, texte compris, sans ajustement du navigateur", () => {
    expect(selectedClasses).toEqual(["forced-selected"]);
    const css = readFileSync("src/styles.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const block = css.slice(css.indexOf("@media (forced-colors: active)"));
    const rule = block.slice(
      block.indexOf(".forced-selected"),
      block.indexOf("}", block.indexOf(".forced-selected")),
    );
    expect(rule).toContain("forced-color-adjust: none");
    expect(rule).toContain("border-color: Highlight");
    expect(rule).toContain("background-color: Highlight");
    expect(rule).toContain("color: HighlightText");
  });

  it("marque la pastille de type de vente choisie", () => {
    render(<SaleTypeFilter bar value="notary" onChange={vi.fn()} />);
    const group = screen.getByRole("group", { name: "Type de vente" });
    expectOnlyPressedHighlighted(within(group).getAllByRole("button"));
  });

  it("marque l'affichage choisi de la bascule « Cartes / Tableau »", () => {
    render(<ResultsViewToggle view="table" onChange={vi.fn()} />);
    const group = screen.getByRole("group", { name: "Affichage des résultats", hidden: true });
    expectOnlyPressedHighlighted(within(group).getAllByRole("button", { hidden: true }));
  });

  it("marque le filtre rapide actif du mobile", () => {
    render(
      <MobileFilterChips
        draft={{ ...emptySearchDraft(), pepite: true }}
        setDraft={vi.fn()}
        pepitesActive
      />,
    );
    const pepite = screen.getByRole("button", { name: /Pépites seulement/ });
    expect(pepite.getAttribute("aria-pressed")).toBe("true");
    for (const name of selectedClasses) expect(pepite.className).toContain(name);
  });
});
