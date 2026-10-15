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

  it("preloads the background photo only", () => {
    // `preload` of next/image emits a <link rel="preload" as="image">.
    const preloads = hero.match(/<link\b[^>]*rel="preload"[^>]*>/g) ?? [];
    expect(preloads).toHaveLength(1);
    expect(preloads[0]).toContain("home-bordeaux-twilight");

    // The example photo of the file card is an ordinary image: no priority, not forced eager.
    const [dossier] = imageTags(hero, "dossier-apartment");
    expect(dossier).toBeDefined();
    expect(attribute(dossier, "fetchpriority")).toBeUndefined();
    expect(attribute(dossier, "loading")).not.toBe("eager");
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

describe("home figures and free-access line", () => {
  it("shows the real figures with a link to /sales, then the free-access line", () => {
    const markup = renderToStaticMarkup(
      <CinematicHero summary={{ count: 1753, updatedAt: "2026-10-15T07:30:00.000Z" }} />,
    );
    const text = markup.replace(/<[^>]+>/g, "").replace(/\s/g, " ");

    expect(text).toContain("1 753 ventes à venir · mises à jour le 15/10/2026");
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
      expect(markup).not.toContain("mises à jour");
      expect(markup).toContain("Gratuit, sans carte bancaire");
    }
  });

  it("keeps the total alone, singular for one sale, when the date is unknown", () => {
    expect(catalogueSummaryLine({ count: 1, updatedAt: null })).toBe("1 vente à venir");
    expect(catalogueSummaryLine({ count: 12, updatedAt: "pas une date" })).toBe(
      "12 ventes à venir",
    );
  });
});
