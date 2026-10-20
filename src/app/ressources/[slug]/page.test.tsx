import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ override: null as Record<string, unknown> | null }));

vi.mock("@/lib/resource-articles", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/resource-articles")>("@/lib/resource-articles");
  return {
    ...actual,
    getResourceArticle: (slug: string) => {
      const article = actual.getResourceArticle(slug);
      return article && mocks.override ? { ...article, ...mocks.override } : article;
    },
  };
});

import Page, { generateMetadata } from "./page";

const SLUG = "frais-vente-encheres-judiciaire";
const params = Promise.resolve({ slug: SLUG });

function structuredData(html: string) {
  const json = /<script type="application\/ld\+json">(.*?)<\/script>/.exec(html)![1];
  return JSON.parse(json.replaceAll("\\u003c", "<"));
}

describe("article page", () => {
  beforeEach(() => {
    mocks.override = null;
    process.env.SITE_URL = "https://immojudis.com";
  });

  it("uses the headline as <title> when the article has no seoTitle", async () => {
    const metadata = await generateMetadata({ params });
    expect(metadata.title).toBe("Frais d’une vente aux enchères judiciaire");
  });

  it("uses seoTitle for the <title> and the shares while the h1 keeps the headline", async () => {
    mocks.override = { seoTitle: "Frais d’une vente aux enchères : le détail" };
    const metadata = await generateMetadata({ params });
    expect(metadata.title).toBe("Frais d’une vente aux enchères : le détail");
    expect(metadata.openGraph).toMatchObject({
      title: "Frais d’une vente aux enchères : le détail",
    });
    expect(metadata.twitter).toMatchObject({ title: "Frais d’une vente aux enchères : le détail" });

    const html = renderToStaticMarkup(await Page({ params }));
    expect(html).toMatch(/<h1>Frais d’une vente aux enchères judiciaire<\/h1>/);
    expect(structuredData(html)["@graph"][0].headline).toBe(
      "Frais d’une vente aux enchères judiciaire",
    );
  });

  it("states dateModified: updatedAt when set, the publication date otherwise", async () => {
    const plain = structuredData(renderToStaticMarkup(await Page({ params })))["@graph"][0];
    expect(plain.datePublished).toBe("2026-10-13");
    expect(plain.dateModified).toBe("2026-10-13");
    expect((await generateMetadata({ params })).openGraph).not.toHaveProperty("modifiedTime");

    mocks.override = { updatedAt: "2026-11-02" };
    const updated = structuredData(renderToStaticMarkup(await Page({ params })))["@graph"][0];
    expect(updated.datePublished).toBe("2026-10-13");
    expect(updated.dateModified).toBe("2026-11-02");
    expect((await generateMetadata({ params })).openGraph).toMatchObject({
      modifiedTime: "2026-11-02",
    });
  });

  it("shows « Mis à jour le » only when updatedAt differs from the publication date", async () => {
    const plain = renderToStaticMarkup(await Page({ params }));
    expect(plain).not.toContain("Mis à jour le");

    mocks.override = { updatedAt: "2026-10-13" };
    expect(renderToStaticMarkup(await Page({ params }))).not.toContain("Mis à jour le");

    mocks.override = { updatedAt: "2026-11-02" };
    const updated = renderToStaticMarkup(await Page({ params }));
    expect(updated).toContain("Mis à jour le");
    expect(updated).toContain('<time dateTime="2026-11-02">2 novembre 2026</time>');
    // The publication date stays.
    expect(updated).toContain('<time dateTime="2026-10-13">');
  });

  it("ends the visible breadcrumb with the title, like the BreadcrumbList", async () => {
    const html = renderToStaticMarkup(await Page({ params }));
    const nav = /<nav[^>]*aria-label="Fil d’Ariane">(.*?)<\/nav>/.exec(html)![1];
    const visible = [...nav.matchAll(/<(?:a|span)\b[^>]*>([^<]+)<\/(?:a|span)>/g)]
      .map((match) => match[1])
      .filter((text) => text !== "/");
    const listed = structuredData(html)["@graph"][1].itemListElement.map(
      (item: { name: string }) => item.name,
    );
    expect(visible).toEqual(listed);
    expect(visible.at(-1)).toBe("Frais d’une vente aux enchères judiciaire");
  });

  it("uses seoDescription for the meta description and the shares, description otherwise", async () => {
    const plain = await generateMetadata({ params });
    expect(String(plain.description).length).toBeGreaterThan(0);
    const description = plain.description;

    mocks.override = { seoDescription: "Une description courte pour les résultats de recherche." };
    const metadata = await generateMetadata({ params });
    expect(metadata.description).toBe("Une description courte pour les résultats de recherche.");
    expect(metadata.openGraph).toMatchObject({ description: metadata.description });
    expect(metadata.twitter).toMatchObject({ description: metadata.description });
    // The page keeps the full description under its headline.
    const html = renderToStaticMarkup(await Page({ params }));
    expect(html).toContain(String(description).replaceAll("’", "’"));
  });

  it("gives the publisher a logo and keeps the breadcrumb", async () => {
    const graph = structuredData(renderToStaticMarkup(await Page({ params })))["@graph"];
    expect(graph[0].publisher).toMatchObject({
      "@type": "Organization",
      name: "Immojudis",
      logo: {
        "@type": "ImageObject",
        url: "https://immojudis.com/brand/immojudis-mark-transparent.png",
      },
    });
    expect(graph[1]["@type"]).toBe("BreadcrumbList");
    expect(graph[1].itemListElement).toHaveLength(3);
  });
});
