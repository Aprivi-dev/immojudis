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
      "Étape 1 : Trouver une vente",
      "Étape 2 : Comprendre le bien",
      "Étape 3 : Fixer son enchère plafond",
      "Étape 4 : Se faire accompagner",
    ]);
  });

  it("ne mentionne plus les limites internes du produit", () => {
    const { container } = render(<Page />);
    expect(container.textContent).not.toMatch(
      /sauvegarde du simulateur|locale au navigateur|n’est pas encore détaillé|apport, le taux|Premium|ventes suivies/i,
    );
  });
});
