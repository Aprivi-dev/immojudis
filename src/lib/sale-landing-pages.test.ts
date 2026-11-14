import { afterEach, describe, expect, it, vi } from "vitest";
import { DEPARTMENT_PAGE_LISTED_SALES, DEPARTMENT_PAGE_MIN_SALES } from "@/lib/department-pages";
import {
  SALE_LANDING_KEYS,
  SALE_LANDING_LISTED_SALES,
  SALE_LANDING_PAGES,
  isSaleLandingIndexable,
  isSaleLandingVisible,
  saleLandingMetadata,
  saleLandingSearchPath,
  visibleSaleLandingKeys,
} from "@/lib/sale-landing-pages";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("pages par type de bien ou de vente : définitions", () => {
  it("a une adresse par page, et chaque clé de l'ordre désigne une page", () => {
    expect(SALE_LANDING_KEYS.map((key) => SALE_LANDING_PAGES[key].path)).toEqual([
      "/maison-aux-encheres",
      "/appartement-aux-encheres",
      "/encheres-notariales",
      "/ventes-immobilieres-etat",
    ]);
    for (const key of SALE_LANDING_KEYS) expect(SALE_LANDING_PAGES[key].key).toBe(key);
  });

  it("renvoie vers la recherche filtrée qui donne les mêmes ventes", () => {
    expect(saleLandingSearchPath(SALE_LANDING_PAGES.house)).toBe("/sales?homeTypes=house");
    expect(saleLandingSearchPath(SALE_LANDING_PAGES.apartment)).toBe("/sales?homeTypes=apartment");
    expect(saleLandingSearchPath(SALE_LANDING_PAGES.notary)).toBe("/sales?saleType=notary");
    // Le filtre « Domaniales » : ventes de l'État, quelle qu'en soit la procédure.
    expect(saleLandingSearchPath(SALE_LANDING_PAGES.state)).toBe("/sales?saleType=state");
  });

  it("suit le seuil et la longueur de liste des pages de département", () => {
    expect(SALE_LANDING_LISTED_SALES).toBe(DEPARTMENT_PAGE_LISTED_SALES);
    const house = SALE_LANDING_PAGES.house;
    expect(isSaleLandingIndexable(house, DEPARTMENT_PAGE_MIN_SALES)).toBe(true);
    expect(isSaleLandingIndexable(house, DEPARTMENT_PAGE_MIN_SALES - 1)).toBe(false);
    expect(isSaleLandingIndexable(house, 3)).toBe(true);
    expect(isSaleLandingIndexable(house, 2)).toBe(false);
    expect(isSaleLandingIndexable(house, 0)).toBe(false);
  });
});

describe("interrupteur des ventes notariales et de l'État", () => {
  it("propose les quatre pages par défaut", () => {
    expect(visibleSaleLandingKeys()).toEqual(SALE_LANDING_KEYS);
    for (const key of SALE_LANDING_KEYS) {
      expect(isSaleLandingVisible(SALE_LANDING_PAGES[key]), key).toBe(true);
    }
  });

  it("masque les pages des notaires et de l'État quand il est coupé, comme leurs filtres", () => {
    vi.stubEnv("NEXT_PUBLIC_NOTARY_STATE_PILOTS_ENABLED", "false");
    expect(visibleSaleLandingKeys()).toEqual(["house", "apartment"]);
    expect(isSaleLandingIndexable(SALE_LANDING_PAGES.notary, 40)).toBe(false);
    expect(isSaleLandingIndexable(SALE_LANDING_PAGES.state, 40)).toBe(false);
    expect(isSaleLandingIndexable(SALE_LANDING_PAGES.house, 40)).toBe(true);
    // La page reste adressable, mais n'est pas indexée.
    const metadata = saleLandingMetadata(
      SALE_LANDING_PAGES.notary,
      { title: "Titre", description: "Description." },
      40,
    );
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates?.canonical).toBe("/encheres-notariales");
  });
});

describe("saleLandingMetadata", () => {
  const text = { title: "Titre", description: "Description." };

  it("pose la canonique et les cartes de partage, sans robots à partir de 3 ventes", () => {
    const metadata = saleLandingMetadata(SALE_LANDING_PAGES.notary, text, 3);
    expect(metadata.robots).toBeUndefined();
    expect(metadata.title).toBe("Titre");
    expect(metadata.alternates?.canonical).toBe("/encheres-notariales");
    expect(metadata.openGraph).toMatchObject({
      url: "/encheres-notariales",
      title: "Titre",
      description: "Description.",
    });
  });

  it("passe en noindex, follow sous le seuil, et quand la base n'a pas pu être lue", () => {
    for (const count of [0, 2, null]) {
      const metadata = saleLandingMetadata(SALE_LANDING_PAGES.state, text, count);
      expect(metadata.robots, String(count)).toEqual({ index: false, follow: true });
      // La page reste adressable : la canonique est posée.
      expect(metadata.alternates?.canonical).toBe("/ventes-immobilieres-etat");
    }
  });
});
