// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { catalogueZone, SalesCatalogueHead } from "./SalesCatalogueHead";

afterEach(cleanup);

const heading = () => screen.getByRole("heading", { level: 1 });

describe("catalogueZone", () => {
  it("nomme la France entière, une ville, ou un département par son nom", () => {
    expect(catalogueZone({})).toEqual({ label: "France entière", phrase: "" });
    expect(catalogueZone({ city: "Pau" })).toEqual({ label: "Pau", phrase: " à Pau" });
    expect(catalogueZone({ department: "13" })).toEqual({
      label: "Bouches-du-Rhône (13)",
      phrase: " dans le département Bouches-du-Rhône (13)",
    });
    // La ville l'emporte sur le département donné avec elle.
    expect(catalogueZone({ city: "Marseille", department: "13" }).label).toBe("Marseille");
  });

  it("dit que la carte borne la recherche dans le surtitre", () => {
    expect(
      catalogueZone({ city: "Pau", viewport: { north: 1, south: 0, east: 1, west: 0 } }).label,
    ).toBe("Zone choisie sur la carte");
  });
});

describe("SalesCatalogueHead", () => {
  it("écrit le titre en phrase, avec le total et les ventes de la semaine surlignés", () => {
    render(<SalesCatalogueHead search={{}} total={833} week={41} />);
    expect(heading().textContent).toBe(
      "833 ventes immobilières aux enchères à venir, dont 41 cette semaine.",
    );
    const figures = heading().querySelectorAll("span.bg-brand-navy");
    expect([...figures].map((figure) => figure.textContent)).toEqual(["833", "41"]);
    for (const figure of figures) expect(figure.className).toContain("tabular-nums");
    expect(screen.getByText("Catalogue · France entière")).toBeTruthy();
  });

  it("garde la zone choisie dans le titre", () => {
    render(<SalesCatalogueHead search={{ department: "13" }} total={28} week={3} />);
    expect(heading().textContent).toBe(
      "28 ventes immobilières aux enchères à venir dans le département Bouches-du-Rhône (13), dont 3 cette semaine.",
    );
    expect(screen.getByText("Catalogue · Bouches-du-Rhône (13)")).toBeTruthy();
    cleanup();
    render(<SalesCatalogueHead search={{ city: "Pau" }} total={1} week={null} />);
    expect(heading().textContent).toBe("1 vente immobilière aux enchères à venir à Pau.");
  });

  it("s'arrête au total sans comptage de la semaine, ou quand il vaut zéro", () => {
    render(<SalesCatalogueHead search={{}} total={833} week={null} />);
    expect(heading().textContent).toBe("833 ventes immobilières aux enchères à venir.");
    cleanup();
    render(<SalesCatalogueHead search={{}} total={833} week={0} />);
    expect(heading().textContent).toBe("833 ventes immobilières aux enchères à venir.");
  });

  it("n'invente aucun chiffre tant que le total n'est pas connu", () => {
    render(<SalesCatalogueHead search={{ city: "Pau" }} total={null} week={4} />);
    expect(heading().textContent).toBe("Ventes immobilières aux enchères à Pau");
    expect(heading().textContent).not.toMatch(/\d/);
  });

  it("dit « aucune vente » pour un total nul", () => {
    render(<SalesCatalogueHead search={{ city: "Pau" }} total={0} week={0} />);
    expect(heading().textContent).toBe("Aucune vente immobilière aux enchères à venir à Pau.");
  });

  it("montre le chapô au visiteur, le suivi à l'abonné, et les actions", () => {
    const { rerender } = render(
      <SalesCatalogueHead
        search={{}}
        total={10}
        week={null}
        lede
        actions={<button type="button">Exporter en CSV</button>}
      />,
    );
    expect(screen.getByText(/Au tribunal, chez le notaire et ventes de l’État/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Exporter en CSV" })).toBeTruthy();
    rerender(
      <SalesCatalogueHead
        search={{}}
        total={10}
        week={null}
        followed={<nav aria-label="Votre suivi" />}
      />,
    );
    expect(screen.queryByText(/Au tribunal, chez le notaire/)).toBeNull();
    expect(screen.getByRole("navigation", { name: "Votre suivi" })).toBeTruthy();
  });
});
