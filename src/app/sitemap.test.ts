import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadSitemapSales: vi.fn(),
  loadSitemapSaleTotal: vi.fn(),
  loadTribunalActivity: vi.fn(),
  loadDepartments: vi.fn(),
  loadHearings: vi.fn(),
}));

vi.mock("@/lib/upcoming-hearings.server", () => ({
  tryLoadUpcomingHearings: mocks.loadHearings,
}));

vi.mock("@/lib/department-pages.server", () => ({
  tryLoadDepartmentCatalogue: mocks.loadDepartments,
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

import sitemap, { maxDuration } from "./sitemap";
import robots from "./robots";
import resourcesSitemap from "./ressources/sitemap";
import salesSitemap, { generateSitemaps as generateSalesSitemaps } from "./sales/sitemap";
import nextConfig from "../../next.config";
import { SITEMAP_URL_LIMIT } from "@/lib/public-sitemap.server";
import { GUIDE_LAST_UPDATED } from "@/lib/guide-dates";
import {
  aggregateDepartments,
  DEPARTMENT_PAGES_MAX_DURATION_SECONDS,
  type DepartmentSaleInput,
} from "@/lib/department-pages";

function departmentSales(department: string, count: number): DepartmentSaleInput[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${department}-${index}`,
    department,
    city: "Ville",
    propertyType: "house",
    saleDate: "2026-11-10T13:00:00Z",
    startingPriceEur: 60_000,
    surfaceM2: 70,
    venueType: "tribunal",
    status: "scheduled",
  }));
}

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
    mocks.loadDepartments.mockReset();
    mocks.loadDepartments.mockResolvedValue({ status: "error" });
    mocks.loadHearings.mockReset();
    mocks.loadHearings.mockResolvedValue({ status: "error" });
  });
  afterEach(() => {
    delete process.env.SITE_URL;
    vi.restoreAllMocks();
  });

  it("allows the render the duration of a full catalogue read", () => {
    expect(maxDuration).toBe(60);
    expect(maxDuration).toBe(DEPARTMENT_PAGES_MAX_DURATION_SECONDS);
  });

  it("is served from the cache and rebuilt every hour, never on every request", async () => {
    const module = await import("./sitemap");
    const { PUBLIC_TRIBUNAL_ACTIVITY_REVALIDATE_SECONDS } = await vi.importActual<
      typeof import("@/lib/public-tribunal-activity.server")
    >("@/lib/public-tribunal-activity.server");
    expect(module.revalidate).toBe(3600);
    expect(module.revalidate).toBe(PUBLIC_TRIBUNAL_ACTIVITY_REVALIDATE_SECONDS);
    // `force-dynamic` would rebuild the file (3.5 s of readings) on every request.
    expect(module).not.toHaveProperty("dynamic");
  });

  it("reads the courts, the departments and the hearings together, not one after the other", async () => {
    const order: string[] = [];
    const slow = <T>(label: string, value: T) =>
      new Promise<T>((resolve) => {
        order.push(`start ${label}`);
        setTimeout(() => {
          order.push(`end ${label}`);
          resolve(value);
        }, 0);
      });
    mocks.loadTribunalActivity.mockImplementation(() =>
      slow("courts", { status: "ok", items: [{ code: "pau" }] }),
    );
    mocks.loadDepartments.mockImplementation(() => slow("departments", { status: "error" }));
    mocks.loadHearings.mockImplementation(() => slow("hearings", { status: "error" }));
    await sitemap();
    // The three readings have all started before the first one ends.
    const firstEnd = order.findIndex((step) => step.startsWith("end"));
    // (The courts are asked twice: by the page list and by the courts-and-hearings paths.)
    expect(new Set(order.slice(0, firstEnd))).toEqual(
      new Set(["start courts", "start departments", "start hearings"]),
    );
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

  it("includes /tribunaux and gives every static page a real last-modified date, except /sales", async () => {
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
    // No reliable date exists for the catalogue page: the newest `updated_at` of a sale moves with
    // every collection run. A missing date is better than a false one.
    expect(byUrl.get("https://immojudis.com/sales")).not.toHaveProperty("lastModified");
  });

  it("never reads the sales for a date any more, whatever their dates are", async () => {
    mocks.loadSitemapSales.mockResolvedValue(manySales);
    const entries = await sitemap();
    expect(mocks.loadSitemapSales).not.toHaveBeenCalled();
    expect(entries.find((entry) => entry.url === "https://immojudis.com/sales")).toEqual({
      url: "https://immojudis.com/sales",
    });
  });

  it("dates the pages that changed after 8 October by their real last change", async () => {
    mocks.loadSitemapSales.mockResolvedValue([]);
    const byUrl = new Map((await sitemap()).map((entry) => [entry.url, entry.lastModified]));
    expect(byUrl.get("https://immojudis.com/offres")).toBe("2026-10-14");
    expect(byUrl.get("https://immojudis.com/ressources")).toBe("2026-10-19");
    expect(byUrl.get("https://immojudis.com/tribunaux")).toBe("2026-10-19");
    expect(byUrl.get("https://immojudis.com/annonce-exemple")).toBe("2026-10-15");
  });

  it("dates the guide with the date it displays (GUIDE_LAST_UPDATED), not its own copy", async () => {
    mocks.loadSitemapSales.mockResolvedValue([]);
    const byUrl = new Map((await sitemap()).map((entry) => [entry.url, entry.lastModified]));
    expect(byUrl.get("https://immojudis.com/ventes-immobilieres-judiciaires")).toBe(
      GUIDE_LAST_UPDATED,
    );
    // The guide re-exports the same constant its page displays.
    const guide = await import("./ventes-immobilieres-judiciaires/resources-guide");
    expect(guide.GUIDE_LAST_UPDATED).toBe(GUIDE_LAST_UPDATED);
  });

  it("stays available when the catalogue cannot be read: /sales has no date, with or without a read", async () => {
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

  it("lists the market-gap method page with its real last change", async () => {
    mocks.loadSitemapSales.mockResolvedValue([]);
    const byUrl = new Map((await sitemap()).map((entry) => [entry.url, entry.lastModified]));
    expect(byUrl.get("https://immojudis.com/methode-ecart-marche")).toBe("2026-10-15");
  });

  describe("department pages", () => {
    const catalogue = aggregateDepartments([
      ...departmentSales("33", 3),
      ...departmentSales("75", 2),
      ...departmentSales("13", 40),
      ...departmentSales("01", 1),
    ]);

    it("lists the index and only the departments with at least 3 upcoming sales", async () => {
      mocks.loadSitemapSales.mockResolvedValue([]);
      mocks.loadDepartments.mockResolvedValue({ status: "ok", catalogue });
      const paths = (await sitemap()).map((entry) => new URL(entry.url).pathname);
      expect(paths).toContain("/ventes-encheres-immobilieres");
      expect(paths).toContain("/ventes-encheres-immobilieres/gironde");
      expect(paths).toContain("/ventes-encheres-immobilieres/bouches-du-rhone");
      // 2 sales and 1 sale: below the threshold, not listed.
      expect(paths).not.toContain("/ventes-encheres-immobilieres/paris");
      expect(paths).not.toContain("/ventes-encheres-immobilieres/ain");
      expect(
        paths.filter((path) => path.startsWith("/ventes-encheres-immobilieres/")),
      ).toHaveLength(2);
    });

    it("lists a department exactly at the threshold and not one sale below", async () => {
      mocks.loadSitemapSales.mockResolvedValue([]);
      mocks.loadDepartments.mockResolvedValue({
        status: "ok",
        catalogue: aggregateDepartments([...departmentSales("33", 3), ...departmentSales("34", 2)]),
      });
      const paths = (await sitemap()).map((entry) => new URL(entry.url).pathname);
      expect(paths).toContain("/ventes-encheres-immobilieres/gironde");
      expect(paths).not.toContain("/ventes-encheres-immobilieres/herault");
    });

    it("does not list the index nor any department while no department qualifies", async () => {
      mocks.loadSitemapSales.mockResolvedValue([]);
      mocks.loadDepartments.mockResolvedValue({
        status: "ok",
        catalogue: aggregateDepartments([...departmentSales("33", 2), ...departmentSales("75", 1)]),
      });
      const paths = (await sitemap()).map((entry) => new URL(entry.url).pathname);
      expect(paths.filter((path) => path.startsWith("/ventes-encheres-immobilieres"))).toEqual([]);
    });

    it("keeps the index but adds no department when the catalogue cannot be read", async () => {
      mocks.loadSitemapSales.mockResolvedValue([]);
      mocks.loadDepartments.mockResolvedValue({ status: "error" });
      const paths = (await sitemap()).map((entry) => new URL(entry.url).pathname);
      expect(paths).toContain("/ventes-encheres-immobilieres");
      expect(paths.filter((path) => path.startsWith("/ventes-encheres-immobilieres/"))).toEqual([]);
    });

    it("gives the department pages no last-modified date (hourly figures are not a change)", async () => {
      mocks.loadSitemapSales.mockResolvedValue([]);
      mocks.loadDepartments.mockResolvedValue({ status: "ok", catalogue });
      const entries = (await sitemap()).filter((entry) =>
        entry.url.includes("/ventes-encheres-immobilieres"),
      );
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) expect(entry).not.toHaveProperty("lastModified");
    });

    it("never lists a department page from /sales or from the articles sitemap", async () => {
      mocks.loadSitemapSales.mockResolvedValue([]);
      mocks.loadDepartments.mockResolvedValue({ status: "ok", catalogue });
      const urls = (await sitemap()).map((entry) => entry.url);
      expect(new Set(urls).size).toBe(urls.length);
      expect(resourcesSitemap().some((entry) => entry.url.includes("ventes-encheres"))).toBe(false);
    });
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
    expect(entries).toHaveLength(16);
    for (const entry of entries) {
      expect(entry.url).toMatch(/^https:\/\/immojudis\.com\/ressources\/[a-z0-9-]+$/);
      expect(entry.lastModified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("dates an article by its last change (updatedAt), else by its publication", () => {
    const byUrl = new Map(resourcesSitemap().map((entry) => [entry.url, entry.lastModified]));
    // Published on 05/10, corrected on 19/10.
    expect(byUrl.get("https://immojudis.com/ressources/prix-plafond-encheres-immobilieres")).toBe(
      "2026-10-19",
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

  it("lists the sales of file 0 from the first one, with the date of their last visible change", async () => {
    mocks.loadSitemapSales.mockResolvedValue(manySales);
    const entries = await salesSitemap({ id: Promise.resolve("0") });
    expect(mocks.loadSitemapSales).toHaveBeenCalledWith(0, SITEMAP_URL_LIMIT);
    expect(entries).toHaveLength(2276);
    expect(entries[1]).toEqual({
      url: `https://immojudis.com/sales/${manySales[1].id}`,
      lastModified: manySales[1].lastModified,
    });
  });

  it("emits no lastmod for a sale without a reliable date", async () => {
    mocks.loadSitemapSales.mockResolvedValue([
      { id: "a", lastModified: null },
      { id: "b", lastModified: "2026-10-20T09:30:00.000Z" },
    ]);
    const entries = await salesSitemap({ id: Promise.resolve("0") });
    expect(entries[0]).toEqual({ url: "https://immojudis.com/sales/a" });
    expect(entries[0]).not.toHaveProperty("lastModified");
    expect(entries[1]).toEqual({
      url: "https://immojudis.com/sales/b",
      lastModified: "2026-10-20T09:30:00.000Z",
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
