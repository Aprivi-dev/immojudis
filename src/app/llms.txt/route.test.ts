import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { COMPANY_DESCRIPTION } from "@/lib/company-description";
import { RESOURCE_ARTICLES } from "@/lib/resource-articles";
import {
  buildLlmsTxt,
  LLMS_TXT_DESCRIPTION_MAX,
  LLMS_TXT_PIVOT_ARTICLES,
  LLMS_TXT_REGROUP_ABOVE_CHARS,
  llmsTxtPages,
} from "@/lib/llms-txt";
import { config, proxy } from "../../proxy";
import robots from "../robots";
import { GET, dynamic } from "./route";

const APP = path.resolve(__dirname, "..");

function open() {
  vi.stubEnv("SEO_INDEXING_ENABLED", "true");
  vi.stubEnv("VERCEL_ENV", "production");
}

beforeEach(() => {
  process.env.SITE_URL = "https://immojudis.com";
});
afterEach(() => {
  delete process.env.SITE_URL;
  vi.unstubAllEnvs();
});

describe("/llms.txt (site ouvert)", () => {
  it("répond en text/plain avec le résumé et un cache court", async () => {
    open();
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("cache-control")).toContain("s-maxage=300");
    const text = await response.text();
    expect(text.startsWith(`# Immojudis\n\n> ${COMPANY_DESCRIPTION}`)).toBe(true);
    expect(text).toContain("ni un conseil juridique ni un conseil financier");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("liste les pages éditoriales attendues, en adresses absolues", async () => {
    open();
    const text = await GET().text();
    for (const pathname of [
      "https://immojudis.com",
      "https://immojudis.com/ventes-immobilieres-judiciaires",
      "https://immojudis.com/ressources",
      "https://immojudis.com/comment-ca-marche",
      "https://immojudis.com/a-propos",
      "https://immojudis.com/offres",
      "https://immojudis.com/methode-ecart-marche",
      "https://immojudis.com/methode-pepites",
      "https://immojudis.com/classement-des-annonces",
      "https://immojudis.com/tribunaux",
      "https://immojudis.com/simulateur-frais-encheres",
    ]) {
      expect(text).toContain(`](${pathname}):`);
    }
    for (const article of RESOURCE_ARTICLES) {
      expect(text).toContain(`](https://immojudis.com/ressources/${article.slug}):`);
    }
  });

  it("ne liste aucune fiche de vente ni aucune page produite à partir du catalogue", async () => {
    open();
    const text = await GET().text();
    const urls = [...text.matchAll(/\]\((https?:\/\/[^)]+)\)/g)].map((match) => match[1]);
    expect(urls.length).toBe(llmsTxtPages().length);
    for (const url of urls) {
      const { pathname } = new URL(url);
      expect(pathname).not.toMatch(
        /^\/(sales|properties|annonce-exemple|ventes-encheres-immobilieres|reports|comparaisons)(\/|$)/,
      );
    }
    expect(text).not.toMatch(/\/sales\b/);
  });

  it("n'invite pas de robot d'IA ailleurs : robots.txt ne change pas", async () => {
    open();
    const result = await robots();
    const rules = Array.isArray(result.rules) ? result.rules : [result.rules];
    expect(rules).toHaveLength(1);
    expect(rules[0].userAgent).toBe("*");
  });

  it("n'écrit aucun tarif d'offre ni promesse commerciale", async () => {
    open();
    const text = await GET().text();
    expect(text).not.toMatch(/\d\s?€|€\s?\/\s?mois|gratuit|sans engagement/i);
  });

  it("reste dynamique : l'interrupteur est lu à chaque requête", () => {
    expect(dynamic).toBe("force-dynamic");
  });
});

describe("/llms.txt (site fermé)", () => {
  it.each(["", "false", "TRUE", "1"])(
    "répond 404 sans liste quand SEO_INDEXING_ENABLED vaut %j",
    async (value) => {
      vi.stubEnv("SEO_INDEXING_ENABLED", value);
      vi.stubEnv("VERCEL_ENV", "production");
      const response = GET();
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      const text = await response.text();
      expect(text).not.toContain("immojudis.com");
      expect(text).not.toContain("](");
    },
  );

  it("répond 404 sur un aperçu Vercel même interrupteur ouvert, comme robots.txt", async () => {
    vi.stubEnv("SEO_INDEXING_ENABLED", "true");
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(GET().status).toBe(404);
    expect(await robots()).toEqual({ rules: { userAgent: "*", disallow: "/" } });
  });

  it("répond 404 par défaut, sans variable", () => {
    vi.stubEnv("SEO_INDEXING_ENABLED", undefined as unknown as string);
    delete process.env.SEO_INDEXING_ENABLED;
    expect(GET().status).toBe(404);
  });

  it("suit la bascule sans redémarrage", () => {
    open();
    expect(GET().status).toBe(200);
    vi.stubEnv("SEO_INDEXING_ENABLED", "false");
    expect(GET().status).toBe(404);
  });
});

describe("contenu du fichier", () => {
  it("ne pointe que vers des pages qui existent dans l'application", () => {
    for (const page of llmsTxtPages()) {
      if (page.path === "/") {
        expect(existsSync(path.join(APP, "page.tsx"))).toBe(true);
      } else if (page.path.startsWith("/ressources/")) {
        expect(existsSync(path.join(APP, "ressources", "[slug]", "page.tsx"))).toBe(true);
        expect(RESOURCE_ARTICLES.some((article) => article.href === page.path)).toBe(true);
      } else {
        expect(
          existsSync(path.join(APP, ...page.path.split("/").filter(Boolean), "page.tsx")),
        ).toBe(true);
      }
    }
  });

  it("n'a pas de doublon et tient en moins de 10 000 caractères", () => {
    const pages = llmsTxtPages();
    expect(new Set(pages.map((page) => page.path)).size).toBe(pages.length);
    expect(buildLlmsTxt("https://immojudis.com").length).toBeLessThan(10_000);
  });

  it("tient aussi en octets : les accents (2) et les apostrophes typographiques (3) pèsent plus", () => {
    const text = buildLlmsTxt("https://immojudis.com");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(12_000);
    expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(text.length);
  });

  it("plafonne la description des pages principales, des méthodes et des outils", () => {
    const articlePaths = new Set(RESOURCE_ARTICLES.map((article) => article.href));
    for (const page of llmsTxtPages().filter((item) => !articlePaths.has(item.path))) {
      expect(page.description.length, page.path).toBeLessThanOrEqual(LLMS_TXT_DESCRIPTION_MAX);
    }
  });

  it("garde tous les articles décrits tant que le fichier reste sous la limite de regroupement", () => {
    const text = buildLlmsTxt("https://immojudis.com");
    if (text.length > LLMS_TXT_REGROUP_ABOVE_CHARS) return;
    expect(text).not.toContain("## Optional");
    for (const article of RESOURCE_ARTICLES) {
      expect(text).toContain(`(https://immojudis.com${article.href}): ${article.description}`);
    }
  });

  it("regroupe les articles non pivots en titre seul sous « Optional » au-delà de 25 articles", () => {
    const pivots = LLMS_TXT_PIVOT_ARTICLES.map((path, index) => ({
      title: `Pivot ${index}`,
      path,
      description: `Description du pivot ${index}.`,
    }));
    const others = Array.from({ length: 20 }, (_, index) => ({
      title: `Autre article ${index}`,
      path: `/ressources/autre-${index}`,
      description: `Description de l’article ${index}, qui ne doit pas figurer.`,
    }));
    const text = buildLlmsTxt("https://immojudis.com", [...others, ...pivots]);
    const [before, optional] = text.split("## Optional");
    expect(optional).toBeDefined();
    // Les pivots gardent leur description, hors de « Optional ».
    for (const pivot of pivots) {
      expect(before).toContain(`[${pivot.title}](https://immojudis.com${pivot.path}): `);
    }
    // Les autres : titre et adresse seulement, en dernière section.
    for (const other of others) {
      expect(optional).toContain(`- [${other.title}](https://immojudis.com${other.path})\n`);
      expect(text).not.toContain(other.description);
    }
    expect(optional).not.toContain("## ");
    expect(text.length).toBeLessThan(10_000);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(12_000);
  });

  it("suit le format llms.txt : un titre, un résumé en citation, des sections de liens", () => {
    const text = buildLlmsTxt("https://immojudis.com");
    const lines = text.split("\n");
    expect(lines[0]).toBe("# Immojudis");
    expect(lines.filter((l) => l.startsWith("# "))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("> "))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("## ")).length).toBeGreaterThanOrEqual(3);
    for (const entry of lines.filter((l) => l.startsWith("- "))) {
      expect(entry).toMatch(/^- \[[^\]]+\]\(https:\/\/immojudis\.com[^)]*\): .+/);
    }
    // « Optional » : liens sans description, permis par llmstxt.org.
    const regrouped = buildLlmsTxt("https://immojudis.com", [
      ...llmsTxtPages().filter((page) => page.path.startsWith("/ressources/")),
      ...Array.from({ length: 5 }, (_, index) => ({
        title: `Supplément ${index}`,
        path: `/ressources/supplement-${index}`,
        description: "Description.",
      })),
    ]);
    expect(regrouped).toMatch(/\n## Optional\n\n- \[[^\]]+\]\(https:\/\/immojudis\.com[^)]*\)\n/);
  });
});

describe("proxy et llms.txt", () => {
  const matches = (pathname: string) =>
    config.matcher.some((pattern) => new RegExp(`^${pattern}$`).test(pathname));

  it("laisse passer la route : le proxy s'applique sans la rediriger ni la bloquer", () => {
    expect(matches("/llms.txt")).toBe(true);
    const response = proxy(new NextRequest("https://immojudis.com/llms.txt"));
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("ajoute noindex à la réponse tant que le site est fermé, rien une fois ouvert", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("SEO_INDEXING_ENABLED", "false");
    expect(
      proxy(new NextRequest("https://immojudis.com/llms.txt")).headers.get("x-robots-tag"),
    ).toBe("noindex, nofollow");
    vi.stubEnv("SEO_INDEXING_ENABLED", "true");
    expect(
      proxy(new NextRequest("https://immojudis.com/llms.txt")).headers.get("x-robots-tag"),
    ).toBeNull();
  });
});
