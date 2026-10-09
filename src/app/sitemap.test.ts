import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ loadSitemapSales: vi.fn(), loadSitemapSaleTotal: vi.fn() }));

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
    expect(entries.every((entry) => entry.url.startsWith("https://immojudis.com"))).toBe(true);
  });

  it("includes /tribunaux and gives every static page a real last-modified date", async () => {
    mocks.loadSitemapSales.mockResolvedValue(manySales);
    const entries = await sitemap();
    const byUrl = new Map(entries.map((entry) => [entry.url, entry]));
    expect(byUrl.has("https://immojudis.com/tribunaux")).toBe(true);
    expect(byUrl.has("https://immojudis.com/annonce-exemple")).toBe(true);
    for (const path of ["", "/avocats", "/accompagnement", "/tribunaux", "/legal"]) {
      expect(byUrl.get(`https://immojudis.com${path}`)?.lastModified).toBeTruthy();
    }
    // The catalogue page changes with its newest sale.
    expect(byUrl.get("https://immojudis.com/sales")?.lastModified).toBe(manySales[0].lastModified);
  });

  it("still serves the static pages when the database cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.loadSitemapSales.mockRejectedValue(new Error("down"));
    const entries = await sitemap();
    expect(entries.length).toBeGreaterThan(10);
    expect(entries.some((entry) => entry.url.includes("/sales/0"))).toBe(false);
    expect(entries.find((entry) => entry.url === "https://immojudis.com/sales")).toBeDefined();
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
    mocks.loadSitemapSaleTotal.mockReset();
  });
  afterEach(() => {
    delete process.env.SITE_URL;
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
});
