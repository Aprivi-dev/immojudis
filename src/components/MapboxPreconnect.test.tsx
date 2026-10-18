import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MapboxPreconnect } from "./MapboxPreconnect";
import SalesLayout from "@/app/sales/layout";

function preconnectLinks(html: string) {
  return html.match(/<link[^>]*rel="preconnect"[^>]*>/g) ?? [];
}

function preconnectOrigins(html: string) {
  return preconnectLinks(html).map((link) => /href="([^"]*)"/.exec(link)?.[1] ?? "");
}

describe("MapboxPreconnect", () => {
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN", "pk.test"));
  afterEach(() => vi.unstubAllEnvs());

  it("prépare la connexion vers api.mapbox.com, sans crossorigin (vignettes en <img>)", () => {
    const links = preconnectLinks(renderToStaticMarkup(<MapboxPreconnect />));
    expect(links).toHaveLength(1);
    expect(links[0]).toContain('href="https://api.mapbox.com"');
    expect(links[0]).not.toMatch(/crossorigin/i);
  });

  it("n'émet rien sans jeton Mapbox", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN", "");
    expect(preconnectLinks(renderToStaticMarkup(<MapboxPreconnect />))).toEqual([]);
  });

  it("est ajoutée par le layout de /sales, qui rend les enfants tels quels", () => {
    const html = renderToStaticMarkup(
      <SalesLayout>
        <p>contenu</p>
      </SalesLayout>,
    );
    expect(preconnectOrigins(html)).toContain("https://api.mapbox.com");
    expect(html).toContain("<p>contenu</p>");
  });
});
