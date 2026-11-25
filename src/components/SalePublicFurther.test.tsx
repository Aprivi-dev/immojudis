// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SalePublicFurther } from "./SalePublicFurther";

function hrefs() {
  return screen.getAllByRole("link").map((link) => link.getAttribute("href"));
}

afterEach(cleanup);

describe("SalePublicFurther", () => {
  it("ajoute les articles propres à la fiche après les liens communs", () => {
    render(
      <SalePublicFurther
        returnTo="/sales"
        guides={[
          { href: "/ressources/a", label: "Article A", hint: "Méthode · 8 min de lecture" },
          { href: "/ressources/b", label: "Article B", hint: "Budget · 9 min de lecture" },
        ]}
      />,
    );
    expect(hrefs()).toEqual([
      "/ventes-immobilieres-judiciaires",
      "/ressources/frais-vente-encheres-judiciaire",
      "/tribunaux",
      "/simulateur-frais-encheres",
      "/ressources/a",
      "/ressources/b",
      "/sales",
    ]);
    expect(screen.getByText("Méthode · 8 min de lecture")).toBeTruthy();
  });

  it("ne répète pas un article déjà dans les liens communs", () => {
    render(
      <SalePublicFurther
        returnTo="/sales"
        guides={[
          { href: "/ressources/frais-vente-encheres-judiciaire", label: "Frais", hint: "Budget" },
        ]}
      />,
    );
    expect(
      hrefs().filter((href) => href === "/ressources/frais-vente-encheres-judiciaire"),
    ).toHaveLength(1);
  });

  it("garde les liens communs seuls sans article transmis", () => {
    render(<SalePublicFurther returnTo="/sales" />);
    expect(hrefs()).toHaveLength(5);
  });
});
