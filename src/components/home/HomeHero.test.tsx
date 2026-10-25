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

    expect(text).toContain("Les enchères immobilières, en toute clarté.");
    expect(text).toContain("1 753 ventes à venir · données vérifiées le 15/10/2026");
    expect(text).not.toContain("mises à jour le");
    expect(markup).toMatch(/<a[^>]*href="\/sales"[^>]*>1[^<]*753 ventes à venir/);
    // Tant que l'état de l'essai n'est pas lu (rendu serveur), la ligne habituelle, vers l'inscription.
    expect(markup).toMatch(
      /<a[^>]*href="\/login\?mode=investor"[^>]*>Gratuit, sans carte bancaire/,
    );
    expect(markup).toMatch(/<a[^>]*href="\/login\?mode=investor"[^>]*>S’inscrire gratuitement/);
  });

  it("says nothing about the catalogue without figures, but keeps the free-access line", () => {
    for (const markup of [
      renderToStaticMarkup(<HomeHero />),
      renderToStaticMarkup(<HomeHero summary={null} />),
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

  it("says that the map is an illustration with fictional dots", () => {
    const markup = renderToStaticMarkup(<HomeHero />);
    expect(markup).toContain(
      'aria-label="Illustration : carte de France parsemée de ventes aux enchères (points fictifs)."',
    );
    expect(visibleText(markup)).toContain("Illustration, points fictifs.");
    expect((markup.match(/<circle\b/g) ?? []).length).toBeGreaterThan(150);
  });

  it("marks the example card on the map as fictional and links it to the example", () => {
    const markup = renderToStaticMarkup(<HomeHero />);
    expect(markup).toMatch(/<a[^>]*href="\/annonce-exemple"[^>]*>.*Exemple fictif/);
    expect(visibleText(markup)).toContain("Appartement de 68 m² à Bordeaux");
  });
});

describe("home figures band", () => {
  it("shows the real figures it knows, and nothing without them", () => {
    expect(renderToStaticMarkup(<HomeStats summary={null} departments={null} />)).toBe("");
    const markup = renderToStaticMarkup(
      <HomeStats summary={{ count: 1548, verifiedAt: null }} departments={94} />,
    );
    // Libellé (dt) puis valeur (dd) ; la valeur s'affiche au-dessus en CSS.
    expect(markup).toMatch(
      /<dt>ventes à venir en France<\/dt><dd[^>]*data-count-to="1548"[^>]*>1.548<\/dd>/,
    );
    expect(markup).toMatch(
      /<dt>départements où une vente est annoncée<\/dt><dd[^>]*data-count-to="94"[^>]*>94<\/dd>/,
    );
    expect(markup).toMatch(
      /<dt>lieux de vente réunis : tribunal, notaire, État<\/dt><dd[^>]*>3<\/dd>/,
    );
  });

  it("leaves out the departments when that figure is unknown", () => {
    const markup = renderToStaticMarkup(
      <HomeStats summary={{ count: 10, verifiedAt: null }} departments={null} />,
    );
    expect(markup).not.toContain("départements");
    expect(markup).toContain("ventes à venir en France");
  });
});
