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
    const opening = '<script type="application/ld+json">';
    const closing = "</script>";
    expect(html.startsWith(opening)).toBe(true);
    expect(html.endsWith(closing)).toBe(true);
    const data = JSON.parse(html.slice(opening.length, -closing.length));
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
