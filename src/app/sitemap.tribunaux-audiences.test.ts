import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mapHearingRows, type UpcomingHearingRow } from "@/lib/upcoming-hearings";

const mocks = vi.hoisted(() => ({
  loadSitemapSales: vi.fn(),
  loadTribunalActivity: vi.fn(),
  loadDepartments: vi.fn(),
  loadHearings: vi.fn(),
}));

vi.mock("@/lib/department-pages.server", () => ({
  tryLoadDepartmentCatalogue: mocks.loadDepartments,
}));
vi.mock("@/lib/public-tribunal-activity.server", () => ({
  loadPublicTribunalActivity: mocks.loadTribunalActivity,
}));
vi.mock("@/lib/upcoming-hearings.server", () => ({
  tryLoadUpcomingHearings: mocks.loadHearings,
}));
vi.mock("@/lib/public-sitemap.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/public-sitemap.server")>(
    "@/lib/public-sitemap.server",
  );
  return { ...actual, loadSitemapSales: mocks.loadSitemapSales };
});

import sitemap from "./sitemap";

function court(searchName: string, upcomingCount: number, code = searchName.toLowerCase()) {
  return {
    code,
    name: searchName.replace(/^TJ /, ""),
    searchName,
    city: null,
    department: "93",
    upcomingCount,
    nextSaleDate: null,
    medianStartingPriceEur: null,
    houseCount: 0,
    apartmentCount: 0,
    otherCount: 0,
  };
}

/** Des audiences à des dates proches de l'instant réel : la fenêtre est celle d'aujourd'hui. */
function soon(count: number) {
  const rows: UpcomingHearingRow[] = Array.from({ length: count }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    sale_date: new Date(Date.now() + 3 * 86_400_000 + index * 3_600_000).toISOString(),
    date_only: false,
    property_type: "house",
    city: "Bobigny",
    department: "93",
    tribunal_code: "bobigny",
    tribunal_name: "TJ Bobigny",
    tribunal_city: "Bobigny",
    starting_price_eur: 50_000 + index,
    total_count: count,
  }));
  return { status: "ok", hearings: mapHearingRows(rows), totalCount: count };
}

async function urls() {
  return (await sitemap()).map((entry) => entry.url);
}

describe("sitemap.xml : pages des tribunaux et des audiences", () => {
  beforeEach(() => {
    vi.stubEnv("SITE_URL", "https://immojudis.com");
    mocks.loadSitemapSales.mockResolvedValue([]);
    mocks.loadDepartments.mockResolvedValue({ status: "error" });
    mocks.loadTribunalActivity.mockResolvedValue({
      status: "ok",
      items: [court("TJ Bobigny", 107), court("TJ Nantes", 3), court("TJ Brest", 2)],
    });
    mocks.loadHearings.mockResolvedValue(soon(3));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("liste les tribunaux d'au moins trois ventes, pas les autres", async () => {
    const list = await urls();
    expect(list).toContain("https://immojudis.com/tribunaux/bobigny");
    expect(list).toContain("https://immojudis.com/tribunaux/nantes");
    expect(list).not.toContain("https://immojudis.com/tribunaux/brest");
  });

  it("liste la page des audiences à partir de trois audiences", async () => {
    expect(await urls()).toContain("https://immojudis.com/audiences-a-venir");

    mocks.loadHearings.mockResolvedValue(soon(2));
    expect(await urls()).not.toContain("https://immojudis.com/audiences-a-venir");

    mocks.loadHearings.mockResolvedValue(soon(0));
    expect(await urls()).not.toContain("https://immojudis.com/audiences-a-venir");
  });

  it("ne compte pas deux fois la même vente publiée par deux sources", async () => {
    const duplicated = soon(3);
    // Deux lignes sur trois sont la même vente (même tribunal, même jour, même mise à prix).
    duplicated.hearings = duplicated.hearings.map((hearing) => ({
      ...hearing,
      startingPriceEur: 50_000,
    }));
    mocks.loadHearings.mockResolvedValue(duplicated);
    expect(await urls()).not.toContain("https://immojudis.com/audiences-a-venir");
  });

  it("ne donne aucune date de modification à ces pages", async () => {
    const entries = await sitemap();
    for (const path of ["/tribunaux/bobigny", "/audiences-a-venir"]) {
      const entry = entries.find((item) => item.url === `https://immojudis.com${path}`);
      expect(entry, path).toBeDefined();
      expect(entry).not.toHaveProperty("lastModified");
    }
  });

  it("reste disponible quand la lecture des tribunaux ou des audiences échoue", async () => {
    mocks.loadTribunalActivity.mockResolvedValue({ status: "error" });
    mocks.loadHearings.mockResolvedValue({ status: "error" });
    const list = await urls();
    expect(list).toContain("https://immojudis.com");
    expect(list.some((url) => url.includes("/tribunaux/"))).toBe(false);
    expect(list).not.toContain("https://immojudis.com/audiences-a-venir");

    // Même une lecture qui lèverait (ce qu'elle ne fait pas) ne fait pas échouer le sitemap.
    mocks.loadTribunalActivity.mockResolvedValue({ status: "ok", items: [court("TJ Bobigny", 5)] });
    mocks.loadHearings.mockRejectedValue(new Error("boom"));
    const afterThrow = await urls();
    expect(afterThrow).toContain("https://immojudis.com");
    expect(afterThrow).not.toContain("https://immojudis.com/audiences-a-venir");
  });

  it("garde la page /tribunaux elle-même et n'écrit aucune adresse en double", async () => {
    const list = await urls();
    expect(list).toContain("https://immojudis.com/tribunaux");
    expect(new Set(list).size).toBe(list.length);
  });
});
