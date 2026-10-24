import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: null, loading: false }) }));
vi.mock("@/hooks/use-launch-offer", () => ({
  useLaunchOffer: () => ({ active: false, pending: false }),
}));
vi.mock("next/form", () => ({
  default: ({ children, ...props }: { children: React.ReactNode }) => (
    <form {...props}>{children}</form>
  ),
}));

import { HomeHero, catalogueSummaryLine } from "./HomeHero";
import { HomeStats } from "./HomeSections";

// Text outside the tags, read character by character (no tag-stripping regex).
function visibleText(markup: string): string {
  let text = "";
  let inTag = false;
  for (const char of markup) {
    if (char === "<") inTag = true;
    else if (char === ">") inTag = false;
    else if (!inTag) text += /\s/.test(char) ? " " : char;
  }
  return text.replace(/\s+/g, " ");
}

describe("home hero", () => {
  it("shows the real figures with a link to /sales, then the free-access line", () => {
    const markup = renderToStaticMarkup(
      <HomeHero summary={{ count: 1753, verifiedAt: "2026-10-15T07:30:00.000Z" }} />,
    );
    const text = visibleText(markup);

    expect(text).toContain("Toutes les ventes aux enchères, sur une seule carte.");
    expect(text).toContain("1 753 ventes à venir · données vérifiées le 15/10/2026");
    expect(text).not.toContain("mises à jour le");
    expect(markup).toMatch(/<a[^>]*href="\/sales"[^>]*>1[^<]*753 ventes à venir/);
    expect(markup).toMatch(/<a[^>]*href="\/offres"[^>]*>Gratuit, sans carte bancaire/);
  });

  it("says nothing about the catalogue without figures, but keeps the free-access line", () => {
    for (const markup of [
      renderToStaticMarkup(<HomeHero />),
      renderToStaticMarkup(<HomeHero summary={null} cells={[]} />),
    ]) {
      expect(markup).not.toContain("ventes à venir");
      expect(markup).not.toContain("vérifiées");
      expect(markup).toContain("Gratuit, sans carte bancaire");
    }
  });

  it("keeps the total alone, singular for one sale, when the date is unknown", () => {
    expect(catalogueSummaryLine({ count: 1, verifiedAt: null })).toBe("1 vente à venir");
    expect(catalogueSummaryLine({ count: 12, verifiedAt: "pas une date" })).toBe(
      "12 ventes à venir",
    );
  });

  it("draws one dot per sector and labels the map with the real total", () => {
    const markup = renderToStaticMarkup(
      <HomeHero
        summary={{ count: 1548, verifiedAt: null }}
        cells={[
          { x: 120.4, y: 260.1, count: 30 },
          { x: 200, y: 100, count: 2 },
        ]}
      />,
    );
    // Le point du secteur, plus son halo : les secteurs les plus fournis en portent un.
    expect(markup.match(/<circle[^>]*cx="200"[^>]*>/g)).toHaveLength(2);
    expect(markup.match(/<circle[^>]*cx="120.4"[^>]*>/g)).toHaveLength(2);
    expect(markup).toMatch(
      /aria-label="Carte de France métropolitaine : les 1.548 ventes à venir, regroupées par secteur."/,
    );
  });

  it("marks the example card on the map as fictional and links it to the example", () => {
    const markup = renderToStaticMarkup(<HomeHero />);
    expect(markup).toMatch(/<a[^>]*href="\/annonce-exemple"[^>]*>.*Exemple fictif/);
    expect(visibleText(markup)).toContain("Appartement de 68 m² à Bordeaux");
  });
});

describe("home figures band", () => {
  it("shows only the figures it knows", () => {
    expect(renderToStaticMarkup(<HomeStats summary={null} map={null} />)).toBe("");
    const markup = renderToStaticMarkup(
      <HomeStats
        summary={{ count: 1548, verifiedAt: null }}
        map={{ cells: [], lowestStartingPrice: 750, venueTypes: 3 }}
      />,
    );
    // Libellé (dt) puis valeur (dd) ; la valeur s'affiche au-dessus en CSS.
    expect(markup).toMatch(
      /<dt>ventes à venir en France<\/dt><dd[^>]*data-count-to="1548"[^>]*>1.548<\/dd>/,
    );
    expect(markup).toMatch(
      /<dt>lieux de vente réunis : tribunal, notaire, État<\/dt><dd[^>]*>3<\/dd>/,
    );
    expect(markup).toMatch(/<dt>la plus petite mise à prix du moment<\/dt><dd[^>]*>750.€<\/dd>/);
  });

  it("does not claim three venues when the catalogue holds fewer", () => {
    const text = visibleText(
      renderToStaticMarkup(
        <HomeStats
          summary={{ count: 10, verifiedAt: null }}
          map={{ cells: [], lowestStartingPrice: null, venueTypes: 1 }}
        />,
      ),
    );
    expect(text).not.toContain("lieux de vente");
    expect(text).not.toContain("mise à prix");
  });
});
