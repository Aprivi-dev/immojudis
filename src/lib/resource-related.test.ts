import { describe, expect, it } from "vitest";
import {
  RESOURCE_ARTICLES,
  RESOURCE_SUMMARIES,
  type ResourceSummary,
} from "@/lib/resource-articles";
import { RESOURCE_TOPICS, relatedResources, understandingResources } from "./resource-related";

function summary(slug: string, category: string): ResourceSummary {
  return {
    slug,
    title: slug,
    category,
    description: "",
    href: `/ressources/${slug}`,
    image: "/x.webp",
    readingMinutes: 5,
  };
}

describe("RESOURCE_TOPICS", () => {
  const slugs = new Set(RESOURCE_SUMMARIES.map((item) => item.slug));

  it("ne vise que des articles qui existent", () => {
    for (const slug of Object.keys(RESOURCE_TOPICS)) expect(slugs.has(slug), slug).toBe(true);
  });

  it("donne au moins un sujet à chaque article qui en a une entrée", () => {
    for (const [slug, topics] of Object.entries(RESOURCE_TOPICS)) {
      expect(topics.length, slug).toBeGreaterThan(0);
    }
  });
});

describe("relatedResources", () => {
  it("propose trois articles distincts, jamais l'article lui-même", () => {
    for (const { slug } of RESOURCE_SUMMARIES) {
      const related = relatedResources(slug);
      expect(related).toHaveLength(3);
      expect(related.map((item) => item.slug)).not.toContain(slug);
      expect(new Set(related.map((item) => item.slug)).size).toBe(3);
    }
  });

  it("n'est plus toujours le même trio", () => {
    const trios = new Set(
      RESOURCE_ARTICLES.map(({ slug }) =>
        relatedResources(slug)
          .map((item) => item.slug)
          .join(","),
      ),
    );
    expect(trios.size).toBeGreaterThan(RESOURCE_ARTICLES.length / 2);
  });

  it("met en tête les articles qui partagent des sujets", () => {
    const related = relatedResources("financer-achat-encheres-pret-delais").map((i) => i.slug);
    // financement + budget en commun, devant les simples articles de la même catégorie.
    expect(related[0]).toBe("frais-vente-encheres-judiciaire");
    expect(related).toContain("prix-plafond-encheres-immobilieres");
  });

  it("rapproche l'article sur le bien occupé de l'immeuble de rapport et de la méthode", () => {
    const related = relatedResources("acheter-bien-occupe-encheres").map((i) => i.slug);
    expect(related).toContain("immeuble-rapport-encheres");
    expect(related).toContain("lire-cahier-conditions-vente-preparer-visite");
  });

  it("classe d'abord par sujets, puis par catégorie, puis par ordre du registre", () => {
    const candidates = [
      summary("courant", "A"),
      summary("autre-categorie", "B"),
      summary("meme-categorie", "A"),
      summary("sujet-commun", "B"),
    ];
    // Les sujets sont lus dans RESOURCE_TOPICS : ces slugs n'en ont pas, seule la catégorie joue.
    expect(relatedResources("courant", 3, candidates).map((i) => i.slug)).toEqual([
      "meme-categorie",
      "autre-categorie",
      "sujet-commun",
    ]);
  });

  it("reste utilisable pour un article ajouté sans sujet, et le propose à son tour", () => {
    const candidates = [summary("nouveau", "Budget"), ...RESOURCE_SUMMARIES.slice(0, 5)];
    expect(relatedResources("nouveau", 3, candidates)).toHaveLength(3);
    expect(
      relatedResources("financer-achat-encheres-pret-delais", 14, [
        ...RESOURCE_SUMMARIES,
        summary("nouveau", "Budget"),
      ]).map((i) => i.slug),
    ).toContain("nouveau");
  });
});

describe("understandingResources", () => {
  it("rend deux articles distincts qui existent", () => {
    for (const seed of ["01", "2A", "33", "75", "971", "bobigny"]) {
      const picked = understandingResources(seed);
      expect(picked).toHaveLength(2);
      expect(picked[0].slug).not.toBe(picked[1].slug);
      for (const item of picked) {
        expect(RESOURCE_SUMMARIES.some((known) => known.slug === item.slug)).toBe(true);
      }
    }
  });

  it("est stable pour une page et varie d'une page à l'autre", () => {
    expect(understandingResources("33")).toEqual(understandingResources("33"));
    const variants = new Set(
      Array.from({ length: 96 }, (_, index) =>
        understandingResources(String(index + 1).padStart(2, "0"))
          .map((item) => item.slug)
          .join(","),
      ),
    );
    expect(variants.size).toBeGreaterThan(4);
  });

  it("saute un article retiré du registre", () => {
    const onlyOne = RESOURCE_SUMMARIES.filter(
      (item) => item.slug === "lire-cahier-conditions-vente-preparer-visite",
    );
    expect(understandingResources("33", onlyOne)).toHaveLength(1);
  });
});
