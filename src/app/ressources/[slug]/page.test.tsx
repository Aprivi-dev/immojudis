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

import { getResourceArticle } from "@/lib/resource-articles";
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
    // The real article now carries an updatedAt: force its absence to test the fallback.
    mocks.override = { updatedAt: undefined };
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
    mocks.override = { updatedAt: undefined };
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
    expect(html).toContain(String(description));
  });

  it("gives the publisher a logo and keeps the breadcrumb", async () => {
    const graph = structuredData(renderToStaticMarkup(await Page({ params })))["@graph"];
    expect(graph[0].publisher).toMatchObject({
      "@type": "Organization",
      name: "Immojudis",
      logo: {
        "@type": "ImageObject",
        url: "https://immojudis.com/icon-512.png",
      },
    });
    expect(graph[1]["@type"]).toBe("BreadcrumbList");
    expect(graph[1].itemListElement).toHaveLength(3);
  });
  it("affiche la réponse directe en tête, puis une FAQ visible reprise à l'identique dans le FAQPage", async () => {
    const html = renderToStaticMarkup(await Page({ params }));
    const article = getResourceArticle(SLUG)!;
    expect(html).toContain("La réponse en bref");
    expect(html.indexOf("La réponse en bref")).toBeLessThan(html.indexOf("L’essentiel à retenir"));
    expect(html).toContain('<a href="#questions-frequentes">Questions fréquentes</a>');

    const faqPage = structuredData(html)["@graph"].find(
      (node: { "@type": string }) => node["@type"] === "FAQPage",
    );
    expect(faqPage.mainEntity).toHaveLength(article.faq!.length);
    const visible = html.replaceAll("&#x27;", "’").replaceAll("&quot;", '"');
    for (const [index, item] of article.faq!.entries()) {
      const node = faqPage.mainEntity[index];
      expect(node["@type"]).toBe("Question");
      expect(node.name).toBe(item.question);
      expect(node.acceptedAnswer).toEqual({ "@type": "Answer", text: item.answer });
      // Chaque question et chaque réponse du balisage figure telle quelle dans le texte visible.
      expect(visible).toContain(`<h3>${item.question}</h3>`);
      expect(visible).toContain(`<p>${item.answer}</p>`);
    }
  });

  it("n'ajoute ni FAQ ni FAQPage à un article qui n'en a pas", async () => {
    mocks.override = { faq: undefined, directAnswer: undefined };
    const html = renderToStaticMarkup(await Page({ params }));
    expect(html).not.toContain("Questions fréquentes");
    expect(html).not.toContain("La réponse en bref");
    const types = structuredData(html)["@graph"].map((node: { "@type": string }) => node["@type"]);
    expect(types).toEqual(["BlogPosting", "BreadcrumbList"]);
  });

  it("affiche le lien vers le simulateur sous l'exemple chiffré", async () => {
    const html = renderToStaticMarkup(await Page({ params }));
    expect(html).toContain('href="/simulateur-frais-encheres"');
  });

  it("n'annonce aucun auteur nommé : la rédaction Immojudis", async () => {
    const html = renderToStaticMarkup(await Page({ params }));
    expect(html).toContain("Par la rédaction Immojudis");
    expect(structuredData(html)["@graph"][0].author).toMatchObject({
      "@type": "Organization",
      name: "Immojudis",
    });
  });
  it("rend le glossaire en liste de définitions avec lien vers l'article détaillé et source", async () => {
    const glossary = Promise.resolve({ slug: "glossaire-encheres-immobilieres" });
    const html = renderToStaticMarkup(await Page({ params: glossary }));
    expect(html).toContain("<dl");
    expect(html).toContain("<dt>Adjudication</dt>");
    expect(html).toContain("Pour approfondir");
    expect(html).toContain("Source : ");
    expect(html).toContain('href="/ressources/jour-audience-encheres-role-avocat"');
    expect(html).not.toContain("Questions fréquentes");
  });

  it("rend les trois nouveaux articles sans erreur, avec FAQPage pour la fiscalité et le DPE", async () => {
    for (const slug of [
      "fiscalite-achat-encheres-occuper-louer-revendre",
      "dpe-diagnostics-travaux-bien-energivore-plafond",
    ]) {
      const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ slug }) }));
      const types = structuredData(html)["@graph"].map(
        (node: { "@type": string }) => node["@type"],
      );
      expect(types, slug).toEqual(["BlogPosting", "BreadcrumbList", "FAQPage"]);
    }
  });
});
