import { describe, expect, it } from "vitest";
import {
  DEPARTMENT_PAGE_LISTED_SALES,
  DEPARTMENT_PAGE_MIN_SALES,
  DEPARTMENT_PAGES_PATH,
  DEPARTMENTS,
  aggregateDepartments,
  departmentFromCode,
  departmentFromSlug,
  departmentItemListStructuredData,
  departmentPageDescription,
  departmentPageTitle,
  departmentSaleCount,
  departmentSearchPath,
  departmentSlug,
  indexableDepartments,
  isDepartmentPageIndexable,
  medianOf,
  type DepartmentSaleInput,
} from "./department-pages";
import { departmentCode } from "./department-code";

function sale(id: string, overrides: Partial<DepartmentSaleInput> = {}): DepartmentSaleInput {
  return {
    id,
    department: "33",
    city: "Bordeaux",
    propertyType: "apartment",
    saleDate: "2026-11-10T13:00:00Z",
    startingPriceEur: 100_000,
    surfaceM2: 50,
    ...overrides,
  };
}

describe("adresses des départements", () => {
  it("donne une adresse lisible et unique à chacun des 101 départements", () => {
    expect(DEPARTMENTS).toHaveLength(101);
    expect(new Set(DEPARTMENTS.map((department) => department.slug)).size).toBe(101);
    for (const department of DEPARTMENTS) {
      expect(department.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(department.path).toBe(`/ventes-encheres-immobilieres/${department.slug}`);
      expect(departmentFromSlug(department.slug)).toBe(department);
      // Le code de chaque département est reconnu par le reste du site (filtre ?department=).
      expect(departmentCode(department.code)).toBe(department.code);
    }
  });

  it.each([
    ["Gironde", "gironde"],
    ["Côte-d'Or", "cote-d-or"],
    ["Côtes-d'Armor", "cotes-d-armor"],
    ["La Réunion", "la-reunion"],
    ["Alpes-de-Haute-Provence", "alpes-de-haute-provence"],
    ["Territoire de Belfort", "territoire-de-belfort"],
    ["Corse-du-Sud", "corse-du-sud"],
  ])("écrit %s en %s", (name, slug) => {
    expect(departmentSlug(name)).toBe(slug);
    expect(DEPARTMENTS.find((department) => department.name === name)?.slug).toBe(slug);
  });

  it("n'accepte que l'adresse exacte", () => {
    expect(departmentFromSlug("gironde")?.code).toBe("33");
    expect(departmentFromSlug("Gironde")).toBeNull();
    expect(departmentFromSlug("33")).toBeNull();
    expect(departmentFromSlug("atlantide")).toBeNull();
    expect(departmentFromSlug("")).toBeNull();
  });

  it("retrouve un département par son code ou par son nom stocké", () => {
    expect(departmentFromCode("33")?.slug).toBe("gironde");
    expect(departmentFromCode("Gironde")?.slug).toBe("gironde");
    expect(departmentFromCode("2a")?.slug).toBe("corse-du-sud");
    expect(departmentFromCode("97")).toBeNull();
    expect(departmentFromCode(null)).toBeNull();
  });

  it("renvoie vers la recherche filtrée avec le code (zéro initial conservé)", () => {
    expect(departmentSearchPath({ code: "01" })).toBe("/sales?department=01");
    expect(departmentSearchPath({ code: "2A" })).toBe("/sales?department=2A");
  });
});

describe("seuil d'indexation", () => {
  it("exige au moins 3 ventes à venir distinctes", () => {
    expect(DEPARTMENT_PAGE_MIN_SALES).toBe(3);
    expect(isDepartmentPageIndexable(0)).toBe(false);
    expect(isDepartmentPageIndexable(2)).toBe(false);
    expect(isDepartmentPageIndexable(3)).toBe(true);
    expect(isDepartmentPageIndexable(250)).toBe(true);
  });

  it("ne liste que les départements au-dessus du seuil", () => {
    const catalogue = aggregateDepartments([
      sale("a", { department: "33" }),
      sale("b", { department: "33" }),
      sale("c", { department: "33" }),
      sale("d", { department: "75" }),
      sale("e", { department: "75" }),
    ]);
    expect(indexableDepartments(catalogue).map((department) => department.slug)).toEqual([
      "gironde",
    ]);
    expect(departmentSaleCount(catalogue, "75")).toBe(2);
    expect(departmentSaleCount(catalogue, "13")).toBe(0);
  });
});

describe("aggregateDepartments", () => {
  it("compte une vente par identifiant, même lue deux fois", () => {
    const catalogue = aggregateDepartments([sale("a"), sale("b"), sale("a"), sale("c"), sale("b")]);
    expect(catalogue.departments["33"].upcomingCount).toBe(3);
    expect(catalogue.departments["33"].sales.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("n'écarte pas deux lignes distinctes aux caractéristiques identiques (pas de dédoublonnage en lecture)", () => {
    const catalogue = aggregateDepartments([sale("a"), sale("b")]);
    expect(catalogue.departments["33"].upcomingCount).toBe(2);
  });

  it("calcule la médiane des mises à prix, sans les prix absents ou nuls", () => {
    const catalogue = aggregateDepartments([
      sale("a", { startingPriceEur: 30_000 }),
      sale("b", { startingPriceEur: 90_000 }),
      sale("c", { startingPriceEur: null }),
      sale("d", { startingPriceEur: 0 }),
      sale("e", { startingPriceEur: 60_000 }),
    ]);
    expect(catalogue.departments["33"].medianStartingPriceEur).toBe(60_000);
    const even = aggregateDepartments([
      sale("a", { startingPriceEur: 10_000 }),
      sale("b", { startingPriceEur: 20_000 }),
    ]);
    expect(even.departments["33"].medianStartingPriceEur).toBe(15_000);
    const none = aggregateDepartments([sale("a", { startingPriceEur: null })]);
    expect(none.departments["33"].medianStartingPriceEur).toBeNull();
  });

  it("prend la prochaine audience la plus proche et classe les ventes par date", () => {
    const catalogue = aggregateDepartments([
      sale("late", { saleDate: "2026-12-01T10:00:00Z" }),
      sale("none", { saleDate: null }),
      sale("soon", { saleDate: "2026-10-20T10:00:00Z" }),
      sale("mid", { saleDate: "2026-11-05T10:00:00Z" }),
    ]);
    const stats = catalogue.departments["33"];
    expect(stats.nextSaleDate).toBe("2026-10-20T10:00:00Z");
    expect(stats.sales.map((item) => item.id)).toEqual(["soon", "mid", "late", "none"]);
  });

  it("répartit par type de bien, le plus nombreux d'abord", () => {
    const catalogue = aggregateDepartments([
      sale("a", { propertyType: "house" }),
      sale("b", { propertyType: "apartment" }),
      sale("c", { propertyType: "apartment" }),
      sale("d", { propertyType: "other" }),
      sale("e", { propertyType: null }),
    ]);
    expect(catalogue.departments["33"].types).toEqual([
      { label: "Appartement", count: 2 },
      { label: "Bien", count: 1 },
      { label: "Bien à qualifier", count: 1 },
      { label: "Maison", count: 1 },
    ]);
  });

  it("range une vente par code ou par nom de département, et ignore les départements inconnus", () => {
    const catalogue = aggregateDepartments([
      sale("a", { department: "33" }),
      sale("b", { department: "Gironde" }),
      sale("c", { department: "2a" }),
      sale("d", { department: "Atlantide" }),
      sale("e", { department: null }),
    ]);
    expect(Object.keys(catalogue.departments).sort()).toEqual(["2A", "33"]);
    expect(catalogue.departments["33"].upcomingCount).toBe(2);
  });

  it("limite la liste détaillée, mais compte toutes les ventes", () => {
    const rows = Array.from({ length: DEPARTMENT_PAGE_LISTED_SALES + 12 }, (_, index) =>
      sale(`s-${String(index).padStart(3, "0")}`),
    );
    const stats = aggregateDepartments(rows).departments["33"];
    expect(stats.upcomingCount).toBe(DEPARTMENT_PAGE_LISTED_SALES + 12);
    expect(stats.sales).toHaveLength(DEPARTMENT_PAGE_LISTED_SALES);
  });

  it("date la lecture avec l'horloge fournie", () => {
    const now = new Date("2026-10-15T08:00:00Z");
    expect(aggregateDepartments([], now).generatedAt).toBe("2026-10-15T08:00:00.000Z");
  });
});

describe("medianOf", () => {
  it("rend la médiane, ou null sans valeur", () => {
    expect(medianOf([])).toBeNull();
    expect(medianOf([5])).toBe(5);
    expect(medianOf([9, 1, 5])).toBe(5);
    expect(medianOf([1, 2, 3, 10])).toBe(2.5);
  });
});

describe("titres et descriptions", () => {
  it("tient dans 48 caractères de titre pour chaque département", () => {
    for (const department of DEPARTMENTS) {
      expect(departmentPageTitle(department).length).toBeLessThanOrEqual(48);
    }
  });

  it("décrit les chiffres de la page, sans dépasser 158 caractères", () => {
    const stats = {
      upcomingCount: 12,
      nextSaleDate: "2026-11-10T13:00:00Z",
      medianStartingPriceEur: 85_000,
    };
    const gironde = departmentFromSlug("gironde")!;
    const text = departmentPageDescription(gironde, stats);
    expect(text).toContain("12 ventes aux enchères immobilières à venir (Gironde, 33)");
    expect(text).toContain("prochaine audience le 10 novembre 2026");
    expect(text).toMatch(/mise à prix médiane 85\s000 €/);
    for (const department of DEPARTMENTS) {
      for (const sample of [
        stats,
        { ...stats, upcomingCount: 1 },
        { ...stats, medianStartingPriceEur: null },
        { upcomingCount: 4, nextSaleDate: null, medianStartingPriceEur: null },
        null,
      ]) {
        const description = departmentPageDescription(department, sample);
        expect(description.length).toBeLessThanOrEqual(158);
        expect(description.length).toBeGreaterThanOrEqual(60);
      }
    }
  });

  it("accorde le singulier et dit l'absence de vente", () => {
    const gironde = departmentFromSlug("gironde")!;
    expect(
      departmentPageDescription(gironde, {
        upcomingCount: 1,
        nextSaleDate: null,
        medianStartingPriceEur: null,
      }),
    ).toContain("1 vente aux enchères immobilière à venir");
    expect(departmentPageDescription(gironde, null)).toContain("Aucune vente");
  });
});

describe("departmentItemListStructuredData", () => {
  it("liste les ventes en adresses absolues, dans l'ordre de la page", () => {
    const data = departmentItemListStructuredData("https://immojudis.com", [
      { id: "AAA" },
      { id: "bbb" },
    ]);
    expect(data).toEqual({
      "@context": "https://schema.org",
      "@type": "ItemList",
      numberOfItems: 2,
      itemListElement: [
        { "@type": "ListItem", position: 1, url: "https://immojudis.com/sales/aaa" },
        { "@type": "ListItem", position: 2, url: "https://immojudis.com/sales/bbb" },
      ],
    });
  });

  it("n'émet rien sans vente", () => {
    expect(departmentItemListStructuredData("https://immojudis.com", [])).toBeNull();
  });

  it("garde l'index à l'adresse annoncée", () => {
    expect(DEPARTMENT_PAGES_PATH).toBe("/ventes-encheres-immobilieres");
  });
});
