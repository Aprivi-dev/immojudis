// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aggregateDepartments, type DepartmentSaleInput } from "@/lib/department-pages";

const mocks = vi.hoisted(() => ({ catalogue: vi.fn(), tribunals: vi.fn() }));

vi.mock("@/lib/department-pages.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/department-pages.server")>(
    "@/lib/department-pages.server",
  );
  return { ...actual, loadDepartmentCatalogue: mocks.catalogue };
});
vi.mock("@/lib/public-tribunal-activity.server", () => ({
  loadPublicTribunalActivity: mocks.tribunals,
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw Object.assign(new Error("NEXT_HTTP_ERROR_FALLBACK;404"), {
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
  },
}));

import { DEPARTMENT_CATALOGUE_REVALIDATE_SECONDS } from "@/lib/department-pages.server";
import Page, { generateMetadata, generateStaticParams, revalidate } from "./page";

function sale(id: string, overrides: Partial<DepartmentSaleInput> = {}): DepartmentSaleInput {
  return {
    id,
    department: "33",
    city: "Bordeaux",
    propertyType: "apartment",
    saleDate: "2026-11-10T13:00:00Z",
    startingPriceEur: 80_000,
    surfaceM2: 45,
    ...overrides,
  };
}

function params(slug: string) {
  return { params: Promise.resolve({ departement: slug }) };
}

const THREE = [sale("a"), sale("b", { propertyType: "house" }), sale("c", { city: "Mérignac" })];

beforeEach(() => {
  process.env.SITE_URL = "https://immojudis.com";
  mocks.catalogue.mockReset();
  mocks.tribunals.mockReset();
  mocks.tribunals.mockResolvedValue({
    status: "ok",
    items: [
      {
        code: "bordeaux",
        name: "Bordeaux",
        searchName: "TJ Bordeaux",
        city: "Bordeaux",
        department: "33",
        upcomingCount: 9,
        nextSaleDate: null,
        medianStartingPriceEur: null,
        houseCount: 0,
        apartmentCount: 0,
        otherCount: 0,
      },
      {
        code: "paris",
        name: "Paris",
        searchName: "TJ Paris",
        city: "Paris",
        department: "75",
        upcomingCount: 20,
        nextSaleDate: null,
        medianStartingPriceEur: null,
        houseCount: 0,
        apartmentCount: 0,
        otherCount: 0,
      },
    ],
  });
});
afterEach(() => {
  cleanup();
  delete process.env.SITE_URL;
});

describe("page d'un département : génération", () => {
  it("est produite à la première demande puis rafraîchie toutes les heures", async () => {
    expect(await generateStaticParams()).toEqual([]);
    expect(revalidate).toBe(3600);
    expect(revalidate).toBe(DEPARTMENT_CATALOGUE_REVALIDATE_SECONDS);
  });

  it("répond 404 pour une adresse qui n'est pas un département", async () => {
    await expect(Page(params("atlantide"))).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
    await expect(Page(params("Gironde"))).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
    expect(mocks.catalogue).not.toHaveBeenCalled();
  });

  it("garde un département inconnu hors de l'index sans lire la base", async () => {
    const metadata = await generateMetadata(params("atlantide"));
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(mocks.catalogue).not.toHaveBeenCalled();
  });

  it("laisse remonter une panne de la base : pas de page vide mise en cache", async () => {
    mocks.catalogue.mockRejectedValue(new Error("database down"));
    await expect(generateMetadata(params("gironde"))).rejects.toThrow("database down");
    await expect(Page(params("gironde"))).rejects.toThrow("database down");
  });
});

describe("page d'un département : indexation", () => {
  it("est indexable à partir de 3 ventes à venir, avec canonical et Open Graph", async () => {
    mocks.catalogue.mockResolvedValue(aggregateDepartments(THREE));
    const metadata = await generateMetadata(params("gironde"));
    expect(metadata.robots).toBeUndefined();
    expect(metadata.title).toBe("Enchères immobilières : Gironde");
    expect(metadata.alternates?.canonical).toBe("/ventes-encheres-immobilieres/gironde");
    expect(metadata.openGraph).toMatchObject({
      url: "/ventes-encheres-immobilieres/gironde",
      siteName: "Immojudis",
    });
    expect(String(metadata.description)).toContain("3 ventes aux enchères immobilières à venir");
    expect(String(metadata.description).length).toBeLessThanOrEqual(158);
  });

  it("passe en noindex, follow sous le seuil de 3 ventes", async () => {
    mocks.catalogue.mockResolvedValue(aggregateDepartments(THREE.slice(0, 2)));
    const metadata = await generateMetadata(params("gironde"));
    expect(metadata.robots).toEqual({ index: false, follow: true });
    // La page reste adressable : titre et canonical sont posés.
    expect(metadata.alternates?.canonical).toBe("/ventes-encheres-immobilieres/gironde");
  });

  it("passe en noindex pour un département sans aucune vente, et reste servie", async () => {
    mocks.catalogue.mockResolvedValue(aggregateDepartments(THREE));
    const metadata = await generateMetadata(params("ain"));
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(String(metadata.description)).toContain("Aucune vente");
    const { container } = render(await Page(params("ain")));
    expect(container.textContent).toContain("Aucune vente à venir n’est référencée");
  });
});

describe("page d'un département : contenu", () => {
  it("montre les chiffres calculés sur nos ventes, la répartition et la liste", async () => {
    mocks.catalogue.mockResolvedValue(aggregateDepartments(THREE));
    const { container } = render(await Page(params("gironde")));

    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual([
      "Ventes aux enchères immobilières : Gironde (33)",
    ]);
    const figures = screen.getByRole("region", { name: "Les chiffres du département" });
    expect(figures.textContent).toContain("Ventes à venir3");
    expect(figures.textContent).toContain("10 novembre 2026");
    expect(figures.textContent).toMatch(/80\s000\s€/);

    const types = screen.getByRole("region", { name: "Répartition par type de bien" });
    expect(
      within(types)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Appartement2", "Maison1"]);

    const list = screen.getByRole("region", { name: "Les ventes à venir" });
    const links = within(list).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/sales/a",
      "/sales/b",
      "/sales/c",
    ]);
    expect(container.textContent).toContain("Mérignac");
  });

  it("renvoie vers la recherche du département et vers les tribunaux concernés", async () => {
    mocks.catalogue.mockResolvedValue(aggregateDepartments(THREE));
    render(await Page(params("gironde")));
    expect(
      screen.getByRole("link", { name: /Voir les 3 ventes en Gironde/ }).getAttribute("href"),
    ).toBe("/sales?department=33");

    const tribunals = screen.getByRole("region", { name: "Tribunaux et ventes" });
    const hrefs = within(tribunals)
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    expect(hrefs).toContain("/sales?tribunal=TJ+Bordeaux");
    expect(hrefs).toContain("/tribunaux");
    // Le tribunal de Paris n'appartient pas à la Gironde.
    expect(hrefs).not.toContain("/sales?tribunal=TJ+Paris");
  });

  it("garde la page quand l'activité des tribunaux est indisponible", async () => {
    mocks.catalogue.mockResolvedValue(aggregateDepartments(THREE));
    mocks.tribunals.mockResolvedValue({ status: "error" });
    render(await Page(params("gironde")));
    const tribunals = screen.getByRole("region", { name: "Tribunaux et ventes" });
    expect(within(tribunals).getByRole("link", { name: /tous les tribunaux/ })).toBeTruthy();
  });

  it("limite la liste et renvoie vers la recherche pour le reste", async () => {
    const many = Array.from({ length: 45 }, (_, index) =>
      sale(`s-${String(index).padStart(2, "0")}`),
    );
    mocks.catalogue.mockResolvedValue(aggregateDepartments(many));
    render(await Page(params("gironde")));
    const list = screen.getByRole("region", { name: "Les 30 prochaines ventes" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(30);
    expect(
      within(list).getByRole("link", { name: "la recherche du département" }).getAttribute("href"),
    ).toBe("/sales?department=33");
  });

  it("garde un texte d'introduction générique, sans conseil", async () => {
    mocks.catalogue.mockResolvedValue(aggregateDepartments(THREE));
    const { container } = render(await Page(params("gironde")));
    const intro = container.querySelector("header")?.textContent ?? "";
    expect(intro).toContain("catalogue public");
    expect(intro).toContain("ne constituent pas un conseil juridique");
    expect(intro).not.toMatch(/investir|rentab|opportunit/i);
  });
});

describe("page d'un département : données structurées", () => {
  it("émet un fil d'Ariane et la liste des ventes en adresses absolues", async () => {
    mocks.catalogue.mockResolvedValue(aggregateDepartments(THREE));
    const { container } = render(await Page(params("gironde")));
    const blocks = [...container.querySelectorAll('script[type="application/ld+json"]')].map(
      (script) => JSON.parse(script.textContent ?? "{}"),
    );
    const breadcrumb = blocks.find((block) => block["@type"] === "BreadcrumbList");
    expect(breadcrumb.itemListElement.map((item: { name: string }) => item.name)).toEqual([
      "Accueil",
      "Ventes aux enchères par département",
      "Gironde",
    ]);
    expect(breadcrumb.itemListElement.at(-1).item).toBe(
      "https://immojudis.com/ventes-encheres-immobilieres/gironde",
    );
    const itemList = blocks.find((block) => block["@type"] === "ItemList");
    expect(itemList.itemListElement.map((item: { url: string }) => item.url)).toEqual([
      "https://immojudis.com/sales/a",
      "https://immojudis.com/sales/b",
      "https://immojudis.com/sales/c",
    ]);
  });

  it("n'émet pas de liste vide pour un département sans vente", async () => {
    mocks.catalogue.mockResolvedValue(aggregateDepartments(THREE));
    const { container } = render(await Page(params("ain")));
    const types = [...container.querySelectorAll('script[type="application/ld+json"]')].map(
      (script) => JSON.parse(script.textContent ?? "{}")["@type"],
    );
    expect(types).toEqual(["BreadcrumbList"]);
  });
});
