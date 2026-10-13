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

import { CinematicHero } from "./CinematicHome";
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
