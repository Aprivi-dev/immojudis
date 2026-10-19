// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DepartmentSale } from "@/lib/department-pages";

const mocks = vi.hoisted(() => ({ activity: vi.fn(), sales: vi.fn() }));

vi.mock("@/lib/public-tribunal-activity.server", () => ({
  loadPublicTribunalActivity: mocks.activity,
  PUBLIC_TRIBUNAL_ACTIVITY_REVALIDATE_SECONDS: 3600,
}));
vi.mock("@/lib/tribunal-pages.server", () => ({
  TRIBUNAL_SALES_REVALIDATE_SECONDS: 3600,
  tryLoadTribunalSales: mocks.sales,
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw Object.assign(new Error("NEXT_HTTP_ERROR_FALLBACK;404"), {
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
  },
}));

import { TRIBUNAL_SALES_REVALIDATE_SECONDS } from "@/lib/tribunal-pages.server";
import { PUBLIC_TRIBUNAL_ACTIVITY_REVALIDATE_SECONDS } from "@/lib/public-tribunal-activity.server";
import Page, { generateMetadata, generateStaticParams, revalidate } from "./page";

/** Horloge fixe : les ventes ci-dessous sont à venir à cette date, quel que soit le jour réel. */
const NOW = new Date("2026-10-15T08:00:00Z");

function activity(searchName: string, overrides: Record<string, unknown> = {}) {
  return {
    code: `code-${searchName}`,
    name: searchName.replace(/^TJ /, ""),
    searchName,
    city: null,
    department: "93",
    upcomingCount: 12,
    nextSaleDate: "2026-10-20T10:00:00Z",
    medianStartingPriceEur: 40_500,
    houseCount: 2,
    apartmentCount: 9,
    otherCount: 1,
    ...overrides,
  };
}

const BOBIGNY = activity("TJ Bobigny");
const PUY = activity("TJ Tribunal judiciaire du Puy-en-Velay", {
  code: "justice_tj_1_113",
  department: "43",
  upcomingCount: 4,
  nextSaleDate: null,
  medianStartingPriceEur: null,
});
const BEAUVAIS = activity("TJ Beauvais", { department: "60", upcomingCount: 2 });
const NANTERRE = activity("TJ Nanterre", { department: "93", upcomingCount: 5 });

function sale(id: string, overrides: Partial<DepartmentSale> = {}): DepartmentSale {
  return {
    id,
    city: "Bobigny",
    propertyType: "apartment",
    saleDate: "2026-11-10T13:00:00Z",
    startingPriceEur: 80_000,
    surfaceM2: 45,
    venueType: "tribunal",
    status: "scheduled",
    ...overrides,
  };
}

function params(slug: string) {
  return { params: Promise.resolve({ slug }) };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  process.env.SITE_URL = "https://immojudis.com";
  mocks.activity.mockReset();
  mocks.sales.mockReset();
  mocks.activity.mockResolvedValue({ status: "ok", items: [BOBIGNY, NANTERRE, PUY, BEAUVAIS] });
  mocks.sales.mockResolvedValue({ status: "ok", sales: [sale("a"), sale("b"), sale("c")] });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  delete process.env.SITE_URL;
});

describe("page d'un tribunal : génération", () => {
  it("est produite à la première demande puis rafraîchie toutes les heures", async () => {
    expect(await generateStaticParams()).toEqual([]);
    expect(revalidate).toBe(3600);
    expect(revalidate).toBe(TRIBUNAL_SALES_REVALIDATE_SECONDS);
    expect(revalidate).toBe(PUBLIC_TRIBUNAL_ACTIVITY_REVALIDATE_SECONDS);
  });

  it("répond 404 pour une adresse qui n'est pas un tribunal", async () => {
    await expect(Page(params("atlantide"))).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
    await expect(Page(params("Bobigny"))).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
    expect(mocks.sales).not.toHaveBeenCalled();
  });

  it("garde un tribunal inconnu hors de l'index sans lire ses ventes", async () => {
    const metadata = await generateMetadata(params("atlantide"));
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(mocks.sales).not.toHaveBeenCalled();
  });

  it("laisse remonter une panne de l'activité : pas de page vide mise en cache", async () => {
    mocks.activity.mockResolvedValue({ status: "error" });
    await expect(generateMetadata(params("bobigny"))).rejects.toThrow("indisponible");
    await expect(Page(params("bobigny"))).rejects.toThrow("indisponible");
  });
});

describe("page d'un tribunal : indexation", () => {
  it("est indexable à partir de 3 ventes à venir, avec canonical et Open Graph", async () => {
    const metadata = await generateMetadata(params("bobigny"));
    expect(metadata.robots).toBeUndefined();
    expect(metadata.title).toBe("Enchères judiciaires : Bobigny");
    expect(metadata.alternates?.canonical).toBe("/tribunaux/bobigny");
    expect(metadata.openGraph).toMatchObject({ url: "/tribunaux/bobigny", siteName: "Immojudis" });
    expect(String(metadata.description)).toContain(
      "12 ventes judiciaires à venir au tribunal judiciaire de Bobigny",
    );
    expect(String(metadata.description).length).toBeLessThanOrEqual(158);
  });

  it("passe en noindex, follow sous le seuil de 3 ventes, et reste servie", async () => {
    const metadata = await generateMetadata(params("beauvais"));
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates?.canonical).toBe("/tribunaux/beauvais");
    const { container } = render(await Page(params("beauvais")));
    expect(container.querySelector("h1")?.textContent).toContain("tribunal judiciaire de Beauvais");
  });

  it("donne une adresse propre au tribunal du nom doublé « TJ Tribunal judiciaire du … »", async () => {
    const metadata = await generateMetadata(params("le-puy-en-velay"));
    expect(metadata.alternates?.canonical).toBe("/tribunaux/le-puy-en-velay");
    expect(metadata.title).toBe("Enchères judiciaires : Le Puy-en-Velay");
    expect(String(metadata.description)).toContain("au tribunal judiciaire du Puy-en-Velay");
    expect(String(metadata.description)).not.toContain("TJ");
    render(await Page(params("le-puy-en-velay")));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Ventes judiciaires à venir au tribunal judiciaire du Puy-en-Velay",
    );
  });

  it("décrit la prochaine audience de la liste, pas la date d'une vente reportée", async () => {
    mocks.sales.mockResolvedValue({
      status: "ok",
      sales: [
        sale("r", { status: "postponed", saleDate: "2026-10-20T10:00:00Z" }),
        sale("a", { saleDate: "2026-12-01T10:00:00Z" }),
      ],
    });
    const metadata = await generateMetadata(params("bobigny"));
    expect(String(metadata.description)).toContain("1 décembre 2026");
    expect(String(metadata.description)).not.toContain("20 octobre 2026");
  });
});

describe("page d'un tribunal : contenu", () => {
  it("montre les chiffres du catalogue et la liste des ventes avec leur fiche", async () => {
    render(await Page(params("bobigny")));

    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual([
      "Ventes judiciaires à venir au tribunal judiciaire de Bobigny",
    ]);
    const figures = screen.getByRole("region", { name: "Les chiffres du tribunal" });
    expect(figures.textContent).toContain("Ventes à venir12");
    expect(figures.textContent).toContain("Prochaine audience10 novembre 2026");
    expect(figures.textContent).toMatch(/40\s500\s€/);
    expect(figures.textContent).toContain("Maisons 2");
    expect(figures.textContent).toContain("Appartements 9");
  });

  it("liste les prochaines ventes avec un lien vers chaque fiche", async () => {
    mocks.activity.mockResolvedValue({
      status: "ok",
      items: [{ ...BOBIGNY, upcomingCount: 3 }],
    });
    render(await Page(params("bobigny")));

    const list = screen.getByRole("region", { name: "Les ventes à venir" });
    expect(
      within(list)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual(["/sales/a", "/sales/b", "/sales/c"]);
    expect(list.textContent).toContain("audience le 10 novembre 2026");
    expect(list.textContent).toContain("Mise à prix");
    // Aucune adresse exacte : la commune seulement.
    expect(list.textContent).toContain("Bobigny");
  });

  it("annonce « Les N prochaines ventes » quand la liste est plus courte que le total", async () => {
    render(await Page(params("bobigny")));
    const list = screen.getByRole("region", { name: "Les 3 prochaines ventes" });
    expect(
      within(list).getByRole("link", { name: "la recherche du tribunal" }).getAttribute("href"),
    ).toBe("/sales?tribunal=TJ+Bobigny");
  });

  it("marque une vente reportée et ne l'annonce pas comme prochaine audience", async () => {
    mocks.sales.mockResolvedValue({
      status: "ok",
      sales: [
        sale("r", { status: "postponed", saleDate: "2026-10-20T10:00:00Z" }),
        sale("a", { saleDate: "2026-12-01T10:00:00Z" }),
      ],
    });
    render(await Page(params("bobigny")));
    const figures = screen.getByRole("region", { name: "Les chiffres du tribunal" });
    expect(figures.textContent).toContain("1 décembre 2026");
    expect(figures.textContent).not.toContain("20 octobre 2026");
    const list = screen.getByRole("region", { name: "Les 2 prochaines ventes" });
    expect(list.textContent).toContain("Vente reportée · nouvelle date à confirmer");
    expect(list.textContent).not.toContain("audience le 20 octobre 2026");
  });

  it("garde la page, ses chiffres et un renvoi vers la recherche quand la liste est indisponible", async () => {
    mocks.sales.mockResolvedValue({ status: "error" });
    render(await Page(params("bobigny")));

    expect(screen.getByRole("region", { name: "Les chiffres du tribunal" }).textContent).toContain(
      "Ventes à venir12",
    );
    const list = screen.getByRole("region", { name: "Les ventes à venir" });
    expect(list.textContent).toContain("momentanément indisponible");
    expect(
      within(list)
        .getByRole("link", { name: /dans la recherche/ })
        .getAttribute("href"),
    ).toBe("/sales?tribunal=TJ+Bobigny");
  });

  it("ajoute le bloc « Pour comprendre » avec le guide, deux articles et les autres tribunaux du département", async () => {
    render(await Page(params("bobigny")));

    const block = screen.getByRole("region", { name: "Pour comprendre" });
    const hrefs = within(block)
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    expect(hrefs[0]).toBe("/ventes-immobilieres-judiciaires");
    expect(hrefs.filter((href) => href?.startsWith("/ressources/"))).toHaveLength(2);
    // Seine-Saint-Denis : la page du département et l'autre tribunal du 93, pas ceux d'ailleurs.
    expect(hrefs).toContain("/ventes-encheres-immobilieres/seine-saint-denis");
    expect(hrefs).toContain("/tribunaux/nanterre");
    expect(hrefs).not.toContain("/tribunaux/beauvais");
    expect(hrefs).not.toContain("/tribunaux/bobigny");
  });

  it("garde un texte d'introduction générique, sans conseil", async () => {
    const { container } = render(await Page(params("bobigny")));
    const intro = container.querySelector("header")?.textContent ?? "";
    expect(intro).toContain("catalogue public");
    expect(intro).toContain("ne constituent pas un conseil juridique");
    expect(intro).not.toMatch(/investir|rentab|opportunit/i);
    expect(intro).not.toMatch(/adjug|prix d’adjudication/i);
  });
});

describe("page d'un tribunal : données structurées", () => {
  it("émet un fil d'Ariane et la liste des ventes en adresses absolues", async () => {
    const { container } = render(await Page(params("bobigny")));
    const blocks = [...container.querySelectorAll('script[type="application/ld+json"]')].map(
      (script) => JSON.parse(script.textContent ?? "{}"),
    );
    const breadcrumb = blocks.find((block) => block["@type"] === "BreadcrumbList");
    expect(breadcrumb.itemListElement.map((item: { name: string }) => item.name)).toEqual([
      "Accueil",
      "Tribunaux",
      "Bobigny",
    ]);
    expect(breadcrumb.itemListElement.at(-1).item).toBe("https://immojudis.com/tribunaux/bobigny");
    const itemList = blocks.find((block) => block["@type"] === "ItemList");
    expect(itemList.itemListElement.map((item: { url: string }) => item.url)).toEqual([
      "https://immojudis.com/sales/a",
      "https://immojudis.com/sales/b",
      "https://immojudis.com/sales/c",
    ]);
  });

  it("n'émet pas de liste vide quand les ventes ne sont pas lues", async () => {
    mocks.sales.mockResolvedValue({ status: "error" });
    const { container } = render(await Page(params("bobigny")));
    const types = [...container.querySelectorAll('script[type="application/ld+json"]')].map(
      (script) => JSON.parse(script.textContent ?? "{}")["@type"],
    );
    expect(types).toEqual(["BreadcrumbList"]);
  });
});
