import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadSitemapSales: vi.fn(),
  loadTribunalActivity: vi.fn(),
}));

vi.mock("@/lib/public-tribunal-activity.server", () => ({
  loadPublicTribunalActivity: mocks.loadTribunalActivity,
}));

vi.mock("@/lib/public-sitemap.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/public-sitemap.server")>(
    "@/lib/public-sitemap.server",
  );
  return { ...actual, loadSitemapSales: mocks.loadSitemapSales };
});

import sitemap from "./sitemap";

const PAGE_URL = "https://immojudis.com/prix-encheres-immobilieres";

async function sitemapUrls() {
  return (await sitemap()).map((entry) => entry.url);
}

describe("sitemap.xml et la page « prix réels des adjudications »", () => {
  beforeEach(() => {
    vi.stubEnv("SITE_URL", "https://immojudis.com");
    mocks.loadSitemapSales.mockResolvedValue([]);
    mocks.loadTribunalActivity.mockResolvedValue({ status: "ok", items: [{ code: "pau" }] });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("ne la liste pas par défaut", async () => {
    expect(await sitemapUrls()).not.toContain(PAGE_URL);
  });

  it("ne la liste pas avec un seul des deux interrupteurs ouvert", async () => {
    vi.stubEnv("PUBLIC_ADJUDICATION_PRICES_ENABLED", "true");
    expect(await sitemapUrls()).not.toContain(PAGE_URL);
    vi.unstubAllEnvs();
    vi.stubEnv("SITE_URL", "https://immojudis.com");
    vi.stubEnv("ADJUDICATION_PRICE_STATISTICS_ENABLED", "true");
    expect(await sitemapUrls()).not.toContain(PAGE_URL);
  });

  it("la liste quand les deux interrupteurs valent exactement « true »", async () => {
    vi.stubEnv("PUBLIC_ADJUDICATION_PRICES_ENABLED", "true");
    vi.stubEnv("ADJUDICATION_PRICE_STATISTICS_ENABLED", "true");
    expect(await sitemapUrls()).toContain(PAGE_URL);
  });
});
