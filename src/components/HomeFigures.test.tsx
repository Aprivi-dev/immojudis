import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { formatNumber } from "@/lib/format";
import { HomeFigures, homeFigures } from "./HomeFigures";

describe("HomeFigures", () => {
  it("shows the three figures computed from our data", () => {
    expect(homeFigures({ count: 1550, verifiedAt: "2026-10-19T06:30:00.000Z" }, 87)).toEqual([
      { value: formatNumber(1550), label: "ventes à venir" },
      { value: "87", label: "tribunaux avec des ventes à venir" },
      { value: "19 oct. 2026", label: "dernière vérification des données" },
    ]);
  });

  it("drops an unknown figure instead of inventing one, and uses the singular", () => {
    expect(homeFigures({ count: 1, verifiedAt: null }, 1)).toEqual([
      { value: "1", label: "vente à venir" },
      { value: "1", label: "tribunal avec des ventes à venir" },
    ]);
    expect(homeFigures({ count: 12, verifiedAt: "pas une date" }, null)).toEqual([
      { value: "12", label: "ventes à venir" },
    ]);
    expect(homeFigures(null, null)).toEqual([]);
  });

  it("keeps the text but no list at all when no figure is known", () => {
    const markup = renderToStaticMarkup(<HomeFigures />);
    expect(markup).toContain("Nous lisons les annonces");
    expect(markup).not.toContain("<dl");
  });

  it("never claims to cover every sale or every court", () => {
    const markup = renderToStaticMarkup(
      <HomeFigures summary={{ count: 1550, verifiedAt: null }} tribunalCount={87} />,
    );
    expect(markup).not.toMatch(/toutes les ventes|tous les tribunaux|exhausti/i);
  });
});
