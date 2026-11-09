import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mapHearingRows, type UpcomingHearingRow } from "@/lib/upcoming-hearings";

const mocks = vi.hoisted(() => ({
  loadSitemapSales: vi.fn(),
  loadTribunalActivity: vi.fn(),
  loadDepartments: vi.fn(),
  loadHearings: vi.fn(),
  loadDirectory: vi.fn(),
  loadTribunalSales: vi.fn(),
}));

vi.mock("@/lib/tribunal-pages.server", () => ({
  tryLoadTribunalSales: mocks.loadTribunalSales,
}));

vi.mock("@/lib/department-pages.server", () => ({
  tryLoadDepartmentCatalogue: mocks.loadDepartments,
}));
vi.mock("@/lib/public-tribunal-activity.server", () => ({
  loadPublicTribunalActivity: mocks.loadTribunalActivity,
}));
vi.mock("@/lib/public-tribunal-directory.server", () => ({
  tryLoadPublicTribunalDirectory: mocks.loadDirectory,
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

/** Liste lue par la page d'un tribunal : `received` lignes, dont `listed` après les doublons. */
function tribunalSales(received: number, listed = received) {
  return {
    status: "ok",
    received,
    sales: Array.from({ length: listed }, (_, index) => ({ id: `sale-${index}` })),
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
      items: [
        court("TJ Bobigny", 107, "justice_tj_1_93"),
        court("TJ Nantes", 3, "justice_tj_1_114"),
        court("TJ Brest", 2, "justice_tj_1_29"),
      ],
    });
    mocks.loadDirectory.mockResolvedValue({ status: "error" });
    mocks.loadHearings.mockResolvedValue(soon(3));
    // Par défaut, aucune vente en double : la page compte comme l'activité.
    mocks.loadTribunalSales.mockReset().mockImplementation(async () => tribunalSales(0));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("liste les tribunaux d'au moins trois ventes, pas les autres", async () => {
    const list = await urls();
    expect(list).toContain("https://immojudis.com/tribunaux/tribunal-judiciaire-bobigny");
    expect(list).toContain("https://immojudis.com/tribunaux/tribunal-judiciaire-nantes");
    expect(list).not.toContain("https://immojudis.com/tribunaux/tribunal-judiciaire-brest");
  });

  it("n'annonce pas un tribunal qui n'atteint trois ventes qu'avec un doublon (sa page est en noindex)", async () => {
    // Nantes : trois lignes, dont deux fois la même vente. Sa page en compte deux.
    mocks.loadTribunalSales.mockImplementation(async (code: string) =>
      code === "justice_tj_1_114" ? tribunalSales(3, 2) : tribunalSales(0),
    );
    const list = await urls();
    expect(list).toContain("https://immojudis.com/tribunaux/tribunal-judiciaire-bobigny");
    expect(list).not.toContain("https://immojudis.com/tribunaux/tribunal-judiciaire-nantes");
    // Seuls les tribunaux au-dessus du seuil sont relus, et une seule fois chacun.
    expect(mocks.loadTribunalSales.mock.calls.map(([code]) => code).sort()).toEqual([
      "justice_tj_1_114",
      "justice_tj_1_93",
    ]);
  });

  it("garde un tribunal dont la liste n'a pu être lue, comme le fait sa page", async () => {
    mocks.loadTribunalSales.mockResolvedValue({ status: "error" });
    expect(await urls()).toContain("https://immojudis.com/tribunaux/tribunal-judiciaire-nantes");
  });

  it("n'a qu'une adresse par tribunal : l'adresse lisible, jamais celle par code", async () => {
    const list = (await urls()).filter((url) => url.includes("/tribunaux/"));
    expect(list).toEqual([
      "https://immojudis.com/tribunaux/tribunal-judiciaire-bobigny",
      "https://immojudis.com/tribunaux/tribunal-judiciaire-nantes",
    ]);
    expect(list.some((url) => url.includes("justice-tj"))).toBe(false);
  });

  it("n'écrit pas l'adresse lisible d'un nom que deux tribunaux se partagent", async () => {
    mocks.loadTribunalActivity.mockResolvedValue({
      status: "ok",
      items: [
        court("TJ Saint-Pierre", 5, "justice_tj_1_97"),
        court("TJ Nantes", 3, "justice_tj_1_114"),
      ],
    });
    // Le second « Saint-Pierre » n'a aucune vente à venir : seul le référentiel le connaît.
    mocks.loadDirectory.mockResolvedValue({
      status: "ok",
      items: [
        { code: "justice_tj_1_97", name: "Saint-Pierre", searchName: "TJ Saint-Pierre" },
        { code: "justice_tj_1_50", name: "Saint-Pierre", searchName: "TJ Saint-Pierre" },
      ],
    });
    const list = (await urls()).filter((url) => url.includes("/tribunaux/"));
    expect(list).toEqual([
      "https://immojudis.com/tribunaux/justice-tj-1-97",
      "https://immojudis.com/tribunaux/tribunal-judiciaire-nantes",
    ]);
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
    // Les trois lignes sont la même vente : le même groupe d'adresses sources. Le prix, le jour et le
    // tribunal ne suffisent pas à fusionner (voir le test suivant).
    duplicated.hearings = duplicated.hearings.map((hearing) => ({
      ...hearing,
      sourceGroup: "00000000-0000-4000-8000-000000000001",
    }));
    mocks.loadHearings.mockResolvedValue(duplicated);
    expect(await urls()).not.toContain("https://immojudis.com/audiences-a-venir");
  });

  it("compte deux lots distincts du même tribunal, du même jour et au même prix", async () => {
    const lots = soon(3);
    lots.hearings = lots.hearings.map((hearing) => ({
      ...hearing,
      startingPriceEur: 50_000,
      sourceGroup: null,
    }));
    mocks.loadHearings.mockResolvedValue(lots);
    expect(await urls()).toContain("https://immojudis.com/audiences-a-venir");
  });

  it("ne donne aucune date de modification à ces pages", async () => {
    const entries = await sitemap();
    for (const path of ["/tribunaux/tribunal-judiciaire-bobigny", "/audiences-a-venir"]) {
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
