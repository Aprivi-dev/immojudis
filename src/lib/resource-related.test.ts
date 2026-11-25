import { describe, expect, it } from "vitest";
import {
  RESOURCE_ARTICLES,
  RESOURCE_SUMMARIES,
  type ResourceSummary,
} from "@/lib/resource-articles";
import {
  RELATED_ARTICLES_SHOWN,
  RESOURCE_TOPICS,
  relatedResources,
  rotatingResources,
  understandingAndRotatingResources,
  understandingResources,
} from "./resource-related";

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

  it("donne des sujets aux guides du 14/11/2026, qui ne proposent plus tous les mêmes articles", () => {
    const guides = [
      "acheter-maison-aux-encheres-etapes-frais-risques",
      "adjudication-immobiliere-vente-par-adjudication",
      "immobilier-notaires-annonces-vente-interactive-encheres",
      "ventes-domaniales-etat-biens-immobiliers-mobiliers",
      "encheres-immobilieres-en-ligne-distance",
    ];
    for (const slug of guides) expect(RESOURCE_TOPICS[slug], slug).toBeDefined();
    const trios = guides.map((slug) =>
      relatedResources(slug)
        .map((item) => item.slug)
        .join(","),
    );
    expect(new Set(trios).size).toBeGreaterThanOrEqual(4);
    // Ventes notariales et domaniales : le comparatif ; vente à distance : l'avocat.
    expect(trios[2]).toContain("ventes-notariales-domaniales-differences-tribunal");
    expect(trios[3]).toContain("ventes-notariales-domaniales-differences-tribunal");
    expect(trios[4]).toContain("avocat-obligatoire-encherir-tribunal-choisir-mandat-cout");
    expect(trios[1]).toContain("apres-adjudication-surenchere-paiement-titre-vente");
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
    // financement + budget en commun (la garantie de 10 %), devant un seul sujet commun (les frais).
    expect(related.slice(0, 2)).toEqual([
      "garantie-10-pourcent-cheque-banque-caution-encheres",
      "frais-vente-encheres-judiciaire",
    ]);
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

describe("liens reçus par chaque article du blog", () => {
  it("chaque article est proposé au bas d'au moins un autre article", () => {
    const linked = new Set(
      RESOURCE_ARTICLES.flatMap(({ slug }) =>
        relatedResources(slug, RELATED_ARTICLES_SHOWN).map((item) => item.slug),
      ),
    );
    for (const { slug } of RESOURCE_ARTICLES) expect(linked.has(slug), slug).toBe(true);
  });

  it("chaque article a des sujets déclarés", () => {
    for (const { slug } of RESOURCE_ARTICLES) expect(RESOURCE_TOPICS[slug], slug).toBeDefined();
  });
});

describe("rotatingResources", () => {
  const seeds = Array.from({ length: 400 }, (_, index) => `vente-${index * 7919}`);

  it("rend des articles du blog distincts, stables pour une page, jamais le guide pilier", () => {
    for (const seed of seeds.slice(0, 40)) {
      const picked = rotatingResources(seed, 2);
      expect(picked).toHaveLength(2);
      expect(picked[0].slug).not.toBe(picked[1].slug);
      expect(picked).toEqual(rotatingResources(seed, 2));
      for (const item of picked) expect(item.href.startsWith("/ressources/")).toBe(true);
    }
  });

  it("donne des liens à tous les articles du blog, pas à quelques-uns", () => {
    const counts = new Map<string, number>();
    for (const seed of seeds) {
      for (const item of rotatingResources(seed, 2)) {
        counts.set(item.slug, (counts.get(item.slug) ?? 0) + 1);
      }
    }
    for (const { slug } of RESOURCE_ARTICLES)
      expect(counts.get(slug) ?? 0, slug).toBeGreaterThan(0);
  });

  it("écarte les articles exclus et ne rend pas plus d'articles qu'il n'en reste", () => {
    const excluded = RESOURCE_ARTICLES.slice(0, RESOURCE_ARTICLES.length - 1).map((a) => a.slug);
    const last = RESOURCE_ARTICLES[RESOURCE_ARTICLES.length - 1].slug;
    expect(rotatingResources("33", 3, excluded).map((item) => item.slug)).toEqual([last]);
    expect(rotatingResources("33", 2, [], [])).toEqual([]);
  });
});

describe("understandingAndRotatingResources", () => {
  it("rend trois articles distincts : les deux du lot, puis un autre article du blog", () => {
    for (const seed of ["01", "2A", "33", "75", "971", "bobigny"]) {
      const picked = understandingAndRotatingResources(seed);
      expect(picked.slice(0, 2)).toEqual(understandingResources(seed));
      expect(new Set(picked.map((item) => item.slug)).size).toBe(3);
    }
  });
});
