import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhotoMirrorPreconnect } from "./PhotoMirrorPreconnect";
import SalesLayout from "@/app/sales/layout";

function preconnectLinks(html: string) {
  return html.match(/<link[^>]*rel="preconnect"[^>]*>/g) ?? [];
}

describe("PhotoMirrorPreconnect", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://ci.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_PHOTO_MIRROR", "on");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("prépare la connexion vers l'origine du stockage, sans crossorigin (images sans CORS)", () => {
    const links = preconnectLinks(renderToStaticMarkup(<PhotoMirrorPreconnect />));
    expect(links).toHaveLength(1);
    expect(links[0]).toContain('href="https://ci.supabase.co"');
    expect(links[0]).not.toMatch(/crossorigin/i);
  });

  it("n'émet rien quand l'interrupteur des copies est éteint", () => {
    vi.stubEnv("NEXT_PUBLIC_PHOTO_MIRROR", "");
    expect(preconnectLinks(renderToStaticMarkup(<PhotoMirrorPreconnect />))).toEqual([]);
  });

  it("n'émet rien sans URL Supabase", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    expect(preconnectLinks(renderToStaticMarkup(<PhotoMirrorPreconnect />))).toEqual([]);
  });
});

describe("layout de /sales et de la fiche", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://ci.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_PHOTO_MIRROR", "on");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("ajoute la préconnexion et rend les enfants tels quels", () => {
    const html = renderToStaticMarkup(
      <SalesLayout>
        <p>contenu</p>
      </SalesLayout>,
    );
    expect(preconnectLinks(html)).toHaveLength(1);
    expect(html).toContain("<p>contenu</p>");
  });
});
