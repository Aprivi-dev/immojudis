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
import nextConfig from "../../next.config";
import { ROOT_SITEMAP_SALE_CAPACITY, SITEMAP_URL_LIMIT } from "@/lib/public-sitemap.server";

const manySales = Array.from({ length: 2276 }, (_, index) => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  lastModified: new Date(Date.UTC(2026, 9, 9, 12, 0, 0) - index * 60_000).toISOString(),
}));

describe("sitemap.xml", () => {
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

  it("lists the public sales with their update date (more than 2 000 URLs)", async () => {
    mocks.loadSitemapSales.mockResolvedValue(manySales);
    const entries = await sitemap();
    expect(mocks.loadSitemapSales).toHaveBeenCalledWith(0, ROOT_SITEMAP_SALE_CAPACITY);
    expect(entries.length).toBeGreaterThan(2000);
    const sale = entries.find((entry) => entry.url.endsWith(manySales[1].id));
    expect(sale).toMatchObject({
      url: `https://immojudis.com/sales/${manySales[1].id}`,
      lastModified: manySales[1].lastModified,
    });
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
      "/legal",
      "/classement-des-annonces",
    ]) {
      expect(byUrl.get(`https://immojudis.com${path}`)?.lastModified).toBeTruthy();
    }
    // The catalogue page changes with its newest sale.
    expect(byUrl.get("https://immojudis.com/sales")?.lastModified).toBe(manySales[0].lastModified);
  });

  it("dates an article by its last change (updatedAt), else by its publication", async () => {
    mocks.loadSitemapSales.mockResolvedValue([]);
    const byUrl = new Map((await sitemap()).map((entry) => [entry.url, entry]));
    // Published on 05/10, corrected on 13/10.
    expect(
      byUrl.get("https://immojudis.com/ressources/prix-plafond-encheres-immobilieres")
        ?.lastModified,
    ).toBe("2026-10-13");
    // Published on 13/10, never changed since.
    expect(
      byUrl.get("https://immojudis.com/ressources/frais-vente-encheres-judiciaire")?.lastModified,
    ).toBe("2026-10-13");
  });

  it("answers an error instead of a reduced sitemap when the database cannot be read", async () => {
    mocks.loadSitemapSales.mockRejectedValue(new Error("down"));
    await expect(sitemap()).rejects.toThrow("down");
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
    const entries = await sitemap();
    expect(entries.some((entry) => "changeFrequency" in entry || "priority" in entry)).toBe(false);
  });

  it("never lists the source of a redirect declared in next.config.ts", async () => {
    mocks.loadSitemapSales.mockResolvedValue(manySales.slice(0, 3));
    const paths = (await sitemap()).map((entry) => new URL(entry.url).pathname);
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

  it("stays under the 5 000 URLs per file", async () => {
    mocks.loadSitemapSales.mockResolvedValue(
      Array.from({ length: ROOT_SITEMAP_SALE_CAPACITY }, (_, index) => ({
        id: `s-${index}`,
        lastModified: null,
      })),
    );
    expect((await sitemap()).length).toBeLessThanOrEqual(SITEMAP_URL_LIMIT);
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

  it("points to the sitemap and adds the extra files once the catalogue outgrows it", async () => {
    mocks.loadSitemapSaleTotal.mockResolvedValue(2276);
    expect((await robots()).sitemap).toEqual(["https://immojudis.com/sitemap.xml"]);

    mocks.loadSitemapSaleTotal.mockResolvedValue(ROOT_SITEMAP_SALE_CAPACITY + 6000);
    expect((await robots()).sitemap).toEqual([
      "https://immojudis.com/sitemap.xml",
      "https://immojudis.com/sales/sitemap/0.xml",
      "https://immojudis.com/sales/sitemap/1.xml",
    ]);
  });

  it("keeps working when the database is unreachable", async () => {
    mocks.loadSitemapSaleTotal.mockRejectedValue(new Error("down"));
    expect((await robots()).sitemap).toEqual(["https://immojudis.com/sitemap.xml"]);
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
      expect(result.sitemap).toEqual(["https://immojudis.com/sitemap.xml"]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
