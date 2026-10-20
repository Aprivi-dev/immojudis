// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FavoriteDossierLine } from "./FavoriteDossierLine";

afterEach(cleanup);

describe("FavoriteDossierLine", () => {
  it("affiche un statut et un plafond enregistrés", () => {
    const { container } = render(
      <FavoriteDossierLine
        favorite={{ saleId: "sale-1", personalStatus: "bidding", bidCeilingEur: 185_000 }}
      />,
    );
    expect(container.textContent).toContain("Prêt à enchérir");
    expect(container.textContent).toMatch(/185\s000\s€/);
  });

  it("affiche l'absence de valeur comme une absence", () => {
    const { container } = render(
      <FavoriteDossierLine
        favorite={{ saleId: "sale-1", personalStatus: null, bidCeilingEur: null }}
      />,
    );
    expect(container.textContent).toContain("aucun enregistré");
    expect(container.textContent).toContain("Mon statut : aucun");
  });

  it("n'affiche jamais « 0 € » : un plafond nul compte comme absent", () => {
    const { container } = render(
      <FavoriteDossierLine
        favorite={{ saleId: "sale-1", personalStatus: null, bidCeilingEur: 0 }}
      />,
    );
    expect(container.textContent).not.toMatch(/(^|\s)0\s€/);
    expect(container.textContent).toContain("aucun enregistré");
  });
});
