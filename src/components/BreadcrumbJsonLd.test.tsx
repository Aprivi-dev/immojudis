import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BreadcrumbJsonLd } from "./BreadcrumbJsonLd";

describe("BreadcrumbJsonLd", () => {
  beforeEach(() => {
    process.env.SITE_URL = "https://immojudis.com";
  });
  afterEach(() => {
    delete process.env.SITE_URL;
  });

  it("emits a BreadcrumbList with absolute URLs, Accueil first and no visible markup", () => {
    const html = renderToStaticMarkup(
      <BreadcrumbJsonLd trail={[{ name: "Offres", path: "/offres" }]} />,
    );
    expect(html.startsWith('<script type="application/ld+json">')).toBe(true);
    const data = JSON.parse(/<script[^>]*>(.*)<\/script>/.exec(html)![1]);
    expect(data).toEqual({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Accueil", item: "https://immojudis.com" },
        { "@type": "ListItem", position: 2, name: "Offres", item: "https://immojudis.com/offres" },
      ],
    });
  });
});
