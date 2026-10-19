import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-analysis-checkout-open", () => ({
  useAnalysisCheckoutOpen: () => ({ open: true, loading: false }),
}));
vi.mock("next/form", () => ({
  default: ({ children, ...props }: { children: React.ReactNode }) => (
    <form {...props}>{children}</form>
  ),
}));

import { CinematicHero, catalogueSummaryLine } from "./CinematicHome";
import { HomeDiscovery } from "./HomeDiscovery";

function imageTags(markup: string, file: string): string[] {
  return (markup.match(/<img\b[^>]*>/g) ?? []).filter((tag) => tag.includes(file));
}

function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`, "i").exec(tag)?.[1];
}

describe("home page images", () => {
  const hero = renderToStaticMarkup(<CinematicHero />);
  const discovery = renderToStaticMarkup(<HomeDiscovery />);

  it("loads the example photo eagerly and at high priority, without the `preload` prop", () => {
    // `preload` of next/image is reserved to the background photo (the LCP element on large
    // screens). The example photo of the file card is the LCP element on mobile: eager and
    // high priority instead, as recommended when the LCP element varies with the screen.
    const [dossier] = imageTags(hero, "dossier-apartment");
    expect(dossier).toBeDefined();
    expect(attribute(dossier, "fetchpriority")).toBe("high");
    expect(attribute(dossier, "loading")).toBe("eager");

    // React itself hoists a <link rel="preload"> for an <img fetchPriority="high"> (same URLs as
    // the <img>, so the browser downloads the file once). Nothing else is preloaded.
    const preloads = hero.match(/<link\b[^>]*rel="preload"[^>]*>/g) ?? [];
    expect(preloads).toHaveLength(2);
    expect(preloads[0]).toContain("home-bordeaux-twilight");
    expect(preloads[0]).not.toContain("fetchPriority");
    expect(preloads[1]).toContain("dossier-apartment");
    expect(preloads[1]).toContain('imageSizes="(max-width: 760px) 100vw, 50vw"');
    expect(preloads[1]).toContain('fetchPriority="high"');
  });

  it("does not fetch the example photo a second time further down the page", () => {
    // The second block lazy-loads the same URLs: one download, served from the cache.
    const [inOffers] = imageTags(discovery, "dossier-apartment");
    expect(attribute(inOffers, "loading")).toBe("lazy");
    expect(discovery).not.toMatch(/rel="preload"/);
  });

  it("asks for the same size and quality of dossier-apartment.webp in both blocks", () => {
    const [inHero] = imageTags(hero, "dossier-apartment");
    const [inOffers] = imageTags(discovery, "dossier-apartment");
    expect(inHero && inOffers).toBeTruthy();
    expect(attribute(inOffers, "sizes")).toBe(attribute(inHero, "sizes"));
    expect(attribute(inOffers, "srcset")).toBe(attribute(inHero, "srcset"));
    expect(attribute(inOffers, "src")).toBe(attribute(inHero, "src"));
  });
});

// Text outside the tags, read character by character (no tag-stripping regex).
function visibleText(markup: string): string {
  let text = "";
  let inTag = false;
  for (const char of markup) {
    if (char === "<") inTag = true;
    else if (char === ">") inTag = false;
    else if (!inTag) text += /\s/.test(char) ? " " : char;
  }
  return text;
}

describe("home figures and free-access line", () => {
  it("shows the real figures with a link to /sales, then the free-access line", () => {
    const markup = renderToStaticMarkup(
      <CinematicHero summary={{ count: 1753, verifiedAt: "2026-10-15T07:30:00.000Z" }} />,
    );
    const text = visibleText(markup);

    expect(text).toContain("1 753 ventes à venir · données vérifiées le 15/10/2026");
    // La ligne ne prétend plus que les annonces ont été modifiées ce jour-là.
    expect(text).not.toContain("mises à jour le");
    expect(markup).toMatch(/<a[^>]*href="\/sales"[^>]*>1[^<]*753 ventes à venir/);
    expect(text).toContain("Gratuit, sans carte bancaire · 3 fiches détaillées par mois");
    expect(markup).toMatch(/<a[^>]*href="\/offres"[^>]*>Gratuit, sans carte bancaire/);
  });

  it("says nothing about the catalogue without figures, but keeps the free-access line", () => {
    for (const markup of [
      renderToStaticMarkup(<CinematicHero />),
      renderToStaticMarkup(<CinematicHero summary={null} />),
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
});
