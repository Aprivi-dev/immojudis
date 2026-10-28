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
  departmentNextDateLabel,
  departmentPageDescription,
  departmentPageTitle,
  departmentPriceLabel,
  departmentSaleCount,
  departmentSaleDateText,
  departmentSearchPath,
  departmentSlug,
  identicalSaleRanks,
  indexableDepartments,
  isDepartmentPageIndexable,
  medianOf,
  type DepartmentSaleInput,
} from "./department-pages";
import { departmentCode } from "./department-code";
import type { SaleVenueType } from "./types";

function sale(id: string, overrides: Partial<DepartmentSaleInput> = {}): DepartmentSaleInput {
  return {
    id,
    department: "33",
    city: "Bordeaux",
    propertyType: "apartment",
    saleDate: "2026-11-10T13:00:00Z",
    startingPriceEur: 100_000,
    surfaceM2: 50,
    venueType: "tribunal",
    status: "scheduled",
    ...overrides,
  };
}

/** Horloge fixe : les dates des ventes ci-dessous sont toutes postérieures. */
const NOW = new Date("2026-10-15T08:00:00Z");

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
    const catalogue = aggregateDepartments(
      [sale("a"), sale("b"), sale("a"), sale("c"), sale("b")],
      NOW,
    );
    expect(catalogue.departments["33"].upcomingCount).toBe(3);
    expect(catalogue.departments["33"].sales.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("n'écarte pas deux lignes distinctes aux caractéristiques identiques (pas de dédoublonnage en lecture)", () => {
    const catalogue = aggregateDepartments([sale("a"), sale("b")], NOW);
    expect(catalogue.departments["33"].upcomingCount).toBe(2);
  });

  it("calcule la médiane des mises à prix, sans les prix absents ou nuls", () => {
    const catalogue = aggregateDepartments(
      [
        sale("a", { startingPriceEur: 30_000 }),
        sale("b", { startingPriceEur: 90_000 }),
        sale("c", { startingPriceEur: null }),
        sale("d", { startingPriceEur: 0 }),
        sale("e", { startingPriceEur: 60_000 }),
      ],
      NOW,
    );
    expect(catalogue.departments["33"].medianStartingPriceEur).toBe(60_000);
    const even = aggregateDepartments(
      [sale("a", { startingPriceEur: 10_000 }), sale("b", { startingPriceEur: 20_000 })],
      NOW,
    );
    expect(even.departments["33"].medianStartingPriceEur).toBe(15_000);
    const none = aggregateDepartments([sale("a", { startingPriceEur: null })], NOW);
    expect(none.departments["33"].medianStartingPriceEur).toBeNull();
  });

  it("prend la prochaine audience la plus proche et classe les ventes par date", () => {
    const catalogue = aggregateDepartments(
      [
        sale("late", { saleDate: "2026-12-01T10:00:00Z" }),
        sale("none", { saleDate: null }),
        sale("soon", { saleDate: "2026-10-20T10:00:00Z" }),
        sale("mid", { saleDate: "2026-11-05T10:00:00Z" }),
      ],
      NOW,
    );
    const stats = catalogue.departments["33"];
    expect(stats.nextSaleDate).toBe("2026-10-20T10:00:00Z");
    expect(stats.sales.map((item) => item.id)).toEqual(["soon", "mid", "late", "none"]);
  });

  describe("vocabulaire selon le type de vente", () => {
    it("ne calcule la médiane que sur les mises à prix des ventes au tribunal", () => {
      const stats = aggregateDepartments(
        [
          sale("t1", { startingPriceEur: 40_000 }),
          sale("t2", { startingPriceEur: 80_000 }),
          sale("t3", { startingPriceEur: 60_000 }),
          sale("n1", { venueType: "notary", startingPriceEur: 900_000 }),
          sale("s1", { venueType: "state", startingPriceEur: 700_000 }),
          sale("u1", { venueType: null, startingPriceEur: 500_000 }),
        ],
        NOW,
      ).departments["33"];
      expect(stats.upcomingCount).toBe(6);
      expect(stats.medianStartingPriceEur).toBe(60_000);
      expect(stats.medianSampleSize).toBe(3);
    });

    it("n'invente pas de mise à prix médiane sans vente au tribunal chiffrée", () => {
      const stats = aggregateDepartments(
        [
          sale("n1", { venueType: "notary", startingPriceEur: 900_000 }),
          sale("t1", { startingPriceEur: null }),
          sale("t2", { startingPriceEur: 0 }),
        ],
        NOW,
      ).departments["33"];
      expect(stats.medianStartingPriceEur).toBeNull();
      expect(stats.medianSampleSize).toBe(0);
    });

    it("garde le type de vente et le statut de chaque vente listée", () => {
      const stats = aggregateDepartments(
        [
          sale("a", { venueType: "notary", saleDate: "2026-11-01T10:00:00Z" }),
          sale("b", { status: "postponed", saleDate: "2026-11-02T10:00:00Z" }),
        ],
        NOW,
      ).departments["33"];
      expect(stats.sales.map(({ id, venueType, status }) => [id, venueType, status])).toEqual([
        ["a", "notary", "scheduled"],
        ["b", "tribunal", "postponed"],
      ]);
    });

    it("ne retient comme prochaine date qu'une date future", () => {
      const stats = aggregateDepartments(
        [
          sale("past", { saleDate: "2026-10-01T10:00:00Z" }),
          sale("earlier-today", { saleDate: "2026-10-15T07:59:00Z" }),
          sale("future", { saleDate: "2026-10-30T10:00:00Z" }),
          sale("later", { saleDate: "2026-12-01T10:00:00Z" }),
        ],
        NOW,
      ).departments["33"];
      expect(stats.nextSaleDate).toBe("2026-10-30T10:00:00Z");
      // La vente passée reste comptée et listée : seule la « prochaine date » l'ignore.
      expect(stats.upcomingCount).toBe(4);
    });

    it("exclut les ventes reportées de la prochaine date, même si leur ancienne date est proche", () => {
      const stats = aggregateDepartments(
        [
          sale("reportee", { status: "postponed", saleDate: "2026-10-20T10:00:00Z" }),
          sale("normale", { saleDate: "2026-11-20T10:00:00Z", venueType: "notary" }),
        ],
        NOW,
      ).departments["33"];
      expect(stats.nextSaleDate).toBe("2026-11-20T10:00:00Z");
      expect(stats.nextSaleVenueType).toBe("notary");
    });

    it("n'a pas de prochaine date quand toutes les ventes sont reportées, passées ou sans date", () => {
      const stats = aggregateDepartments(
        [
          sale("a", { status: "postponed", saleDate: "2026-11-01T10:00:00Z" }),
          sale("b", { saleDate: "2026-09-01T10:00:00Z" }),
          sale("c", { saleDate: null }),
          sale("d", { saleDate: "pas une date" }),
        ],
        NOW,
      ).departments["33"];
      expect(stats.nextSaleDate).toBeNull();
      expect(stats.nextSaleVenueType).toBeNull();
    });

    it("n'appelle « audience » et « mise à prix » que le tribunal", () => {
      expect(departmentNextDateLabel("tribunal")).toBe("Prochaine audience");
      expect(departmentNextDateLabel("state")).toBe("Prochaine échéance");
      for (const venueType of ["notary", "online", "unknown", null] as const) {
        expect(departmentNextDateLabel(venueType)).toBe("Prochaine date de vente");
      }
      expect(departmentPriceLabel({ venueType: "tribunal" })).toBe("Mise à prix");
      for (const venueType of ["notary", "state", "online", "unknown", null] as const) {
        expect(departmentPriceLabel({ venueType })).toBe("Prix publié");
      }
    });

    it("écrit la date d'une ligne avec le mot du type de vente", () => {
      const formatted = { date: "10 novembre 2026", time: "14 h 00" };
      const text = (venueType: SaleVenueType | null) =>
        departmentSaleDateText(
          { venueType, status: "scheduled", saleDate: "2026-11-10T13:00:00Z" },
          formatted,
          NOW,
        );
      expect(text("tribunal")).toBe("audience le 10 novembre 2026 à 14 h 00");
      expect(text("notary")).toBe("séance le 10 novembre 2026 à 14 h 00");
      expect(text("state")).toBe("échéance le 10 novembre 2026 à 14 h 00");
      expect(text("online")).toBe("vente le 10 novembre 2026 à 14 h 00");
      expect(text(null)).toBe("vente le 10 novembre 2026 à 14 h 00");
    });

    it("n'annonce ni la date d'une vente reportée ni une date passée comme à venir", () => {
      const formatted = { date: "10 novembre 2026", time: null };
      expect(
        departmentSaleDateText(
          { venueType: "tribunal", status: "postponed", saleDate: "2026-11-10T13:00:00Z" },
          formatted,
          NOW,
        ),
      ).toBe("Vente reportée · nouvelle date à confirmer");
      expect(
        departmentSaleDateText(
          { venueType: "tribunal", status: "scheduled", saleDate: "2026-10-01T13:00:00Z" },
          formatted,
          NOW,
        ),
      ).toBe("Date de vente passée");
      expect(
        departmentSaleDateText(
          { venueType: "tribunal", status: "scheduled", saleDate: null },
          { date: null, time: null },
          NOW,
        ),
      ).toBeNull();
    });
  });

  it("répartit par type de bien, le plus nombreux d'abord", () => {
    const catalogue = aggregateDepartments(
      [
        sale("a", { propertyType: "house" }),
        sale("b", { propertyType: "apartment" }),
        sale("c", { propertyType: "apartment" }),
        sale("d", { propertyType: "other" }),
        sale("e", { propertyType: null }),
      ],
      NOW,
    );
    expect(catalogue.departments["33"].types).toEqual([
      { label: "Appartement", count: 2 },
      { label: "Bien", count: 1 },
      { label: "Bien à qualifier", count: 1 },
      { label: "Maison", count: 1 },
    ]);
  });

  it("range une vente par code ou par nom de département, et ignore les départements inconnus", () => {
    const catalogue = aggregateDepartments(
      [
        sale("a", { department: "33" }),
        sale("b", { department: "Gironde" }),
        sale("c", { department: "2a" }),
        sale("d", { department: "Atlantide" }),
        sale("e", { department: null }),
      ],
      NOW,
    );
    expect(Object.keys(catalogue.departments).sort()).toEqual(["2A", "33"]);
    expect(catalogue.departments["33"].upcomingCount).toBe(2);
  });

  it("limite la liste détaillée, mais compte toutes les ventes", () => {
    const rows = Array.from({ length: DEPARTMENT_PAGE_LISTED_SALES + 12 }, (_, index) =>
      sale(`s-${String(index).padStart(3, "0")}`),
    );
    const stats = aggregateDepartments(rows, NOW).departments["33"];
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
      nextSaleVenueType: "tribunal" as const,
      medianStartingPriceEur: 85_000,
    };
    const gironde = departmentFromSlug("gironde")!;
    const text = departmentPageDescription(gironde, stats);
    expect(text).toContain("12 ventes aux enchères immobilières à venir (Gironde, 33)");
    expect(text).toContain("prochaine audience le 10 novembre 2026");
    expect(text).toMatch(/mise à prix médiane au tribunal 85\s000 €/);
    for (const department of DEPARTMENTS) {
      for (const sample of [
        stats,
        { ...stats, upcomingCount: 1 },
        { ...stats, medianStartingPriceEur: null },
        {
          upcomingCount: 4,
          nextSaleDate: null,
          nextSaleVenueType: null,
          medianStartingPriceEur: null,
        },
        null,
      ]) {
        const description = departmentPageDescription(department, sample);
        expect(description.length).toBeLessThanOrEqual(158);
        expect(description.length).toBeGreaterThanOrEqual(60);
      }
    }
  });

  it("ne parle d'audience et de mise à prix que pour le tribunal", () => {
    const gironde = departmentFromSlug("gironde")!;
    const base = {
      upcomingCount: 5,
      nextSaleDate: "2026-11-10T13:00:00Z",
      medianStartingPriceEur: null,
    };
    expect(departmentPageDescription(gironde, { ...base, nextSaleVenueType: "notary" })).toContain(
      "prochaine vente le 10 novembre 2026",
    );
    expect(departmentPageDescription(gironde, { ...base, nextSaleVenueType: "state" })).toContain(
      "prochaine échéance le 10 novembre 2026",
    );
    for (const venueType of ["notary", "state", "online", "unknown", null] as const) {
      expect(
        departmentPageDescription(gironde, { ...base, nextSaleVenueType: venueType }),
      ).not.toContain("audience");
    }
  });

  it("accorde le singulier et dit l'absence de vente", () => {
    const gironde = departmentFromSlug("gironde")!;
    expect(
      departmentPageDescription(gironde, {
        upcomingCount: 1,
        nextSaleDate: null,
        nextSaleVenueType: null,
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

describe("identicalSaleRanks", () => {
  it("numérote les annonces de même description, sans rien dédoublonner", () => {
    const same = { city: "Marseille", surfaceM2: 58, startingPriceEur: 40_000 };
    const sales = [
      sale("a", same),
      sale("b", same),
      sale("c", { ...same, startingPriceEur: 41_000 }),
      sale("d", same),
    ];
    const ranks = identicalSaleRanks(sales);

    expect(ranks.get("a")).toEqual({ rank: 1, of: 3 });
    expect(ranks.get("b")).toEqual({ rank: 2, of: 3 });
    expect(ranks.get("d")).toEqual({ rank: 3, of: 3 });
    expect(ranks.has("c")).toBe(false);
    expect(sales).toHaveLength(4);
  });
});
