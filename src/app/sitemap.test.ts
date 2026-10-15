import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadSitemapSales: vi.fn(),
  loadSitemapSaleTotal: vi.fn(),
  loadTribunalActivity: vi.fn(),
}));

vi.mock("@/lib/public-tribunal-activity.server", () => ({
  loadPublicTribunalActivity: mocks.loadTribunalActivity,
}));

vi.mock("@/lib/public-sitemap.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/public-sitemap.server")>(
    "@/lib/public-sitemap.server",
  );
  return {
    ...actual,
    loadSitemapSales: mocks.loadSitemapSales,
    loadSitemapSaleTotal: mocks.loadSitemapSaleTotal,
  };
});

import sitemap from "./sitemap";
import robots from "./robots";
import resourcesSitemap from "./ressources/sitemap";
import salesSitemap, { generateSitemaps as generateSalesSitemaps } from "./sales/sitemap";
import nextConfig from "../../next.config";
import { SITEMAP_URL_LIMIT } from "@/lib/public-sitemap.server";

const manySales = Array.from({ length: 2276 }, (_, index) => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  lastModified: new Date(Date.UTC(2026, 9, 9, 12, 0, 0) - index * 60_000).toISOString(),
}));

describe("sitemap.xml (static pages)", () => {
  beforeEach(() => {
    process.env.SITE_URL = "https://immojudis.com";
    mocks.loadSitemapSales.mockReset();
    mocks.loadSitemapSaleTotal.mockReset();
    mocks.loadTribunalActivity.mockReset();
    mocks.loadTribunalActivity.mockResolvedValue({ status: "ok", items: [{ code: "pau" }] });
  });
  afterEach(() => {
    delete process.env.SITE_URL;
    vi.restoreAllMocks();
  });

  it("lists the pages only: no sale and no article", async () => {
    mocks.loadSitemapSales.mockResolvedValue(manySales);
    const entries = await sitemap();
    const paths = entries.map((entry) => new URL(entry.url).pathname);
    expect(paths).toContain("/");
    expect(paths).toContain("/ressources");
    expect(paths).toContain("/ventes-immobilieres-judiciaires");
    expect(paths.filter((path) => path.startsWith("/sales/"))).toEqual([]);
    expect(paths.filter((path) => path.startsWith("/ressources/"))).toEqual([]);
    expect(entries.length).toBeLessThan(50);
    expect(entries.every((entry) => new URL(entry.url).origin === "https://immojudis.com")).toBe(
      true,
    );
  });

  it("includes /tribunaux and gives every static page a real last-modified date", async () => {
    mocks.loadSitemapSales.mockResolvedValue(manySales);
    const entries = await sitemap();
    const byUrl = new Map(entries.map((entry) => [entry.url, entry]));
    expect(byUrl.has("https://immojudis.com/tribunaux")).toBe(true);
    expect(byUrl.has("https://immojudis.com/annonce-exemple")).toBe(true);
    for (const path of [
      "",
      "/avocats",
      "/offres",
      "/tribunaux",
      "/ressources",
      "/annonce-exemple",
      "/legal",
      "/classement-des-annonces",
    ]) {
      expect(byUrl.get(`https://immojudis.com${path}`)?.lastModified).toBeTruthy();
    }
    // The catalogue page changes with its newest sale.
    expect(byUrl.get("https://immojudis.com/sales")?.lastModified).toBe(manySales[0].lastModified);
  });

  it("dates the pages that changed after 8 October by their real last change", async () => {
    mocks.loadSitemapSales.mockResolvedValue([]);
    const byUrl = new Map((await sitemap()).map((entry) => [entry.url, entry.lastModified]));
    expect(byUrl.get("https://immojudis.com/offres")).toBe("2026-10-14");
    expect(byUrl.get("https://immojudis.com/ressources")).toBe("2026-10-13");
    expect(byUrl.get("https://immojudis.com/tribunaux")).toBe("2026-10-13");
    expect(byUrl.get("https://immojudis.com/annonce-exemple")).toBe("2026-10-15");
  });

  it("stays available when the catalogue cannot be read: /sales just has no date", async () => {
    mocks.loadSitemapSales.mockRejectedValue(new Error("down"));
    const entries = await sitemap();
    const sales = entries.find((entry) => entry.url === "https://immojudis.com/sales");
    expect(sales).toBeDefined();
    expect(sales).not.toHaveProperty("lastModified");
    expect(entries.length).toBeGreaterThan(10);
  });

  it("lists /offres, the address of the offers page, not its /accompagnement redirect", async () => {
    mocks.loadSitemapSales.mockResolvedValue([]);
    const urls = (await sitemap()).map((entry) => entry.url);
    expect(urls).toContain("https://immojudis.com/offres");
    expect(urls).not.toContain("https://immojudis.com/accompagnement");
  });

  it("does not list /tribunaux while no court is listed", async () => {
    mocks.loadSitemapSales.mockResolvedValue([]);
    mocks.loadTribunalActivity.mockResolvedValue({ status: "ok", items: [] });
    const urls = (await sitemap()).map((entry) => entry.url);
    expect(urls).not.toContain("https://immojudis.com/tribunaux");
    expect(urls).toContain("https://immojudis.com/sales");
  });

  it("keeps /tribunaux listed when the courts could not be read", async () => {
    mocks.loadSitemapSales.mockResolvedValue([]);
    mocks.loadTribunalActivity.mockResolvedValue({ status: "error" });
    const urls = (await sitemap()).map((entry) => entry.url);
    expect(urls).toContain("https://immojudis.com/tribunaux");
  });

  it("leaves out changeFrequency and priority, which search engines ignore", async () => {
    mocks.loadSitemapSales.mockResolvedValue(manySales.slice(0, 3));
    const entries = [...(await sitemap()), ...resourcesSitemap()];
    expect(entries.some((entry) => "changeFrequency" in entry || "priority" in entry)).toBe(false);
  });

  it("never lists the source of a redirect declared in next.config.ts", async () => {
    mocks.loadSitemapSales.mockResolvedValue(manySales.slice(0, 3));
    const paths = [...(await sitemap()), ...resourcesSitemap()].map(
      (entry) => new URL(entry.url).pathname,
    );
    const redirects = await nextConfig.redirects!();
    expect(redirects.length).toBeGreaterThan(0);
    for (const { source } of redirects) {
      const pattern = new RegExp(
        `^${source.replace(/:[A-Za-z]+\*/g, ".*").replace(/:[A-Za-z]+/g, "[^/]+")}$`,
      );
      expect(
        paths.filter((path) => pattern.test(path)),
        `le sitemap liste une source de redirection (${source})`,
      ).toEqual([]);
    }
  });
});

describe("/ressources/sitemap.xml (articles)", () => {
  beforeEach(() => {
    process.env.SITE_URL = "https://immojudis.com";
  });
  afterEach(() => {
    delete process.env.SITE_URL;
  });

  it("lists every article, and only the articles", () => {
    const entries = resourcesSitemap();
    expect(entries).toHaveLength(13);
    for (const entry of entries) {
      expect(entry.url).toMatch(/^https:\/\/immojudis\.com\/ressources\/[a-z0-9-]+$/);
      expect(entry.lastModified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("dates an article by its last change (updatedAt), else by its publication", () => {
    const byUrl = new Map(resourcesSitemap().map((entry) => [entry.url, entry.lastModified]));
    // Published on 05/10, corrected on 13/10.
    expect(byUrl.get("https://immojudis.com/ressources/prix-plafond-encheres-immobilieres")).toBe(
      "2026-10-13",
    );
    // Published on 13/10, never changed since.
    expect(byUrl.get("https://immojudis.com/ressources/frais-vente-encheres-judiciaire")).toBe(
      "2026-10-13",
    );
  });
});

describe("/sales/sitemap/[id].xml (sales)", () => {
  beforeEach(() => {
    process.env.SITE_URL = "https://immojudis.com";
    mocks.loadSitemapSales.mockReset();
    mocks.loadSitemapSaleTotal.mockReset();
  });
  afterEach(() => {
    delete process.env.SITE_URL;
  });

  it("generates one file per started block of 5 000 sales, none for an empty catalogue", async () => {
    mocks.loadSitemapSaleTotal.mockResolvedValue(0);
    expect(await generateSalesSitemaps()).toEqual([]);
    mocks.loadSitemapSaleTotal.mockResolvedValue(2276);
    expect(await generateSalesSitemaps()).toEqual([{ id: 0 }]);
    mocks.loadSitemapSaleTotal.mockResolvedValue(SITEMAP_URL_LIMIT + 1);
    expect(await generateSalesSitemaps()).toEqual([{ id: 0 }, { id: 1 }]);
    mocks.loadSitemapSaleTotal.mockRejectedValue(new Error("down"));
    expect(await generateSalesSitemaps()).toEqual([]);
  });

  it("lists the sales of file 0 from the first one, with their update date", async () => {
    mocks.loadSitemapSales.mockResolvedValue(manySales);
    const entries = await salesSitemap({ id: Promise.resolve("0") });
    expect(mocks.loadSitemapSales).toHaveBeenCalledWith(0, SITEMAP_URL_LIMIT);
    expect(entries).toHaveLength(2276);
    expect(entries[1]).toEqual({
      url: `https://immojudis.com/sales/${manySales[1].id}`,
      lastModified: manySales[1].lastModified,
    });
  });

  it("starts file 1 where file 0 stops, and stays under 5 000 URLs per file", async () => {
    mocks.loadSitemapSales.mockResolvedValue(
      Array.from({ length: SITEMAP_URL_LIMIT }, (_, index) => ({
        id: `s-${index}`,
        lastModified: null,
      })),
    );
    const entries = await salesSitemap({ id: Promise.resolve("1") });
    expect(mocks.loadSitemapSales).toHaveBeenCalledWith(SITEMAP_URL_LIMIT, 2 * SITEMAP_URL_LIMIT);
    expect(entries.length).toBeLessThanOrEqual(SITEMAP_URL_LIMIT);
  });

  it("answers an error instead of a reduced file when the database cannot be read", async () => {
    mocks.loadSitemapSales.mockRejectedValue(new Error("down"));
    await expect(salesSitemap({ id: Promise.resolve("0") })).rejects.toThrow("down");
  });

  it("ignores an identifier that is not a file number", async () => {
    expect(await salesSitemap({ id: Promise.resolve("abc") })).toEqual([]);
    expect(await salesSitemap({ id: Promise.resolve("-1") })).toEqual([]);
    expect(mocks.loadSitemapSales).not.toHaveBeenCalled();
  });
});

describe("robots.txt", () => {
  beforeEach(() => {
    process.env.SITE_URL = "https://immojudis.com";
    // The indexing switch is closed by default: these tests describe the open site.
    vi.stubEnv("SEO_INDEXING_ENABLED", "true");
    mocks.loadSitemapSaleTotal.mockReset();
  });
  afterEach(() => {
    delete process.env.SITE_URL;
    vi.unstubAllEnvs();
  });

  it("lists the pages, the articles and one sales file per block of 5 000 sales", async () => {
    mocks.loadSitemapSaleTotal.mockResolvedValue(2276);
    expect((await robots()).sitemap).toEqual([
      "https://immojudis.com/sitemap.xml",
      "https://immojudis.com/ressources/sitemap.xml",
      "https://immojudis.com/sales/sitemap/0.xml",
    ]);

    mocks.loadSitemapSaleTotal.mockResolvedValue(SITEMAP_URL_LIMIT * 2 + 1);
    expect((await robots()).sitemap).toEqual([
      "https://immojudis.com/sitemap.xml",
      "https://immojudis.com/ressources/sitemap.xml",
      "https://immojudis.com/sales/sitemap/0.xml",
      "https://immojudis.com/sales/sitemap/1.xml",
      "https://immojudis.com/sales/sitemap/2.xml",
    ]);
  });

  it("lists exactly the sales files that the sales sitemap generates", async () => {
    mocks.loadSitemapSaleTotal.mockResolvedValue(12_345);
    const listed = ((await robots()).sitemap as string[]).filter((url) =>
      url.includes("/sales/sitemap/"),
    );
    const generated = (await generateSalesSitemaps()).map(
      ({ id }) => `https://immojudis.com/sales/sitemap/${id}.xml`,
    );
    expect(listed).toEqual(generated);
  });

  it("keeps working when the database is unreachable: the sales files are just not listed", async () => {
    mocks.loadSitemapSaleTotal.mockRejectedValue(new Error("down"));
    expect((await robots()).sitemap).toEqual([
      "https://immojudis.com/sitemap.xml",
      "https://immojudis.com/ressources/sitemap.xml",
    ]);
  });

  it("drops the obsolete host directive and lets /login be crawled (its noindex must be seen)", async () => {
    mocks.loadSitemapSaleTotal.mockResolvedValue(10);
    const result = await robots();
    expect(result.host).toBeUndefined();
    const rules = Array.isArray(result.rules) ? result.rules[0] : result.rules;
    expect(rules.disallow).toEqual(["/admin/", "/api/", "/publish", "/reports/shared/"]);
  });

  it.each(["preview", "development"])(
    "blocks every crawler, without sitemap, on a Vercel %s deployment",
    async (vercelEnv) => {
      vi.stubEnv("VERCEL_ENV", vercelEnv);
      try {
        expect(await robots()).toEqual({ rules: { userAgent: "*", disallow: "/" } });
        expect(mocks.loadSitemapSaleTotal).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it.each(["", "false", "TRUE", "1", "yes"])(
    "advertises no sitemap and keeps the pages crawlable while SEO_INDEXING_ENABLED is %j",
    async (value) => {
      vi.stubEnv("SEO_INDEXING_ENABLED", value);
      vi.stubEnv("VERCEL_ENV", "production");
      mocks.loadSitemapSaleTotal.mockResolvedValue(10);
      const result = await robots();
      expect(result.sitemap).toBeUndefined();
      expect(mocks.loadSitemapSaleTotal).not.toHaveBeenCalled();
      const rules = Array.isArray(result.rules) ? result.rules[0] : result.rules;
      // `allow` stays: a crawler blocked by `Disallow: /` would never read the noindex header.
      expect(rules.allow).toBe("/");
      expect(rules.disallow).not.toContain("/");
    },
  );

  it("is closed by default: no sitemap when SEO_INDEXING_ENABLED is absent", async () => {
    vi.unstubAllEnvs();
    delete process.env.SEO_INDEXING_ENABLED;
    vi.stubEnv("VERCEL_ENV", "production");
    expect((await robots()).sitemap).toBeUndefined();
  });

  it("stays closed on a Vercel preview even when the switch is open", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(await robots()).toEqual({ rules: { userAgent: "*", disallow: "/" } });
  });

  it("stays open on the Vercel production deployment", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    try {
      mocks.loadSitemapSaleTotal.mockResolvedValue(10);
      const result = await robots();
      expect(Array.isArray(result.rules) ? result.rules[0].allow : result.rules.allow).toBe("/");
      expect(result.sitemap).toEqual([
        "https://immojudis.com/sitemap.xml",
        "https://immojudis.com/ressources/sitemap.xml",
        "https://immojudis.com/sales/sitemap/0.xml",
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
