// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import Page from "./page";

afterEach(cleanup);

describe("page À propos : ce que le site ne fait pas", () => {
  it("reste prudente et range la Pépite parmi les repères calculés, sans bonne affaire ni promesse", () => {
    render(<Page />);
    const block = screen
      .getByRole("heading", { name: "Ce que le site ne fait pas" })
      .closest("article")!;
    const text = (block.textContent ?? "").replace(/\s+/g, " ");
    expect(within(block).getAllByRole("listitem")).toHaveLength(4);
    expect(text).toContain(
      "Il ne fournit ni conseil juridique, ni conseil financier personnalisé.",
    );
    expect(text).toContain("Il ne promet aucun gain, aucune décote");
    expect(text).toContain("une enchère ou une offre plafond est une hypothèse, pas un résultat");
    expect(text).toContain(
      "Le repère « Pépite » est un repère calculé automatiquement sur des critères publics : ce n’est ni une recommandation d’acheter, ni une garantie de prix ou de résultat.",
    );
    expect(text).toContain("Il ne remplace ni la lecture des pièces, ni votre avocat.");
    expect(text).not.toMatch(/bonnes? affaires?/i);
  });
});
