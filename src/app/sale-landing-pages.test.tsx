// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import type { Metadata } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SaleLandingData, SaleLandingKey } from "@/lib/sale-landing-pages";

const mocks = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock("@/lib/sale-landing-pages.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/sale-landing-pages.server")>(
    "@/lib/sale-landing-pages.server",
  );
  return { ...actual, loadSaleLandingForPage: mocks.load };
});

import { SALE_LANDING_REVALIDATE_SECONDS } from "@/lib/sale-landing-pages.server";
import * as housePage from "./maison-aux-encheres/page";
import * as apartmentPage from "./appartement-aux-encheres/page";
import * as notaryPage from "./encheres-notariales/page";
import * as statePage from "./ventes-immobilieres-etat/page";

/** Horloge fixe : les ventes ci-dessous sont à venir à cette date. */
const NOW = new Date("2026-11-14T08:00:00Z");
const TITLE_SUFFIX = " - Immojudis"; // `title.template` de app/layout.tsx
const COMPETITORS = /agorastore|licitor|avoventes|immonotaires|36h|vench|info-ench/i;

type PageModule = typeof housePage;

const PAGES: ReadonlyArray<{
  key: SaleLandingKey;
  path: string;
  module: PageModule;
  title: string;
  /** Titre-phrase attendu pour 12 ventes, 1 vente, aucune vente et une lecture impossible. */
  headings: [string, string, string, string];
  search: string;
}> = [
  {
    key: "house",
    path: "/maison-aux-encheres",
    module: housePage,
    title: "Maison aux enchères : les ventes à venir",
    headings: [
      "12 maisons aux enchères à venir.",
      "1 maison aux enchères à venir.",
      "Aucune maison aux enchères à venir pour le moment.",
      "Maisons aux enchères",
    ],
    search: "/sales?homeTypes=house",
  },
  {
    key: "apartment",
    path: "/appartement-aux-encheres",
    module: apartmentPage,
    title: "Appartement aux enchères : les ventes à venir",
    headings: [
      "12 appartements aux enchères à venir.",
      "1 appartement aux enchères à venir.",
      "Aucun appartement aux enchères à venir pour le moment.",
      "Appartements aux enchères",
    ],
    search: "/sales?homeTypes=apartment",
  },
  {
    key: "notary",
    path: "/encheres-notariales",
    module: notaryPage,
    title: "Enchères notariales : biens immobiliers à venir",
    headings: [
      "Enchères notariales : 12 ventes immobilières à venir.",
      "Enchères notariales : 1 vente immobilière à venir.",
      "Enchères notariales : aucune vente à venir pour le moment.",
      "Enchères notariales",
    ],
    search: "/sales?saleType=notary",
  },
  {
    key: "state",
    path: "/ventes-immobilieres-etat",
    module: statePage,
    title: "Ventes domaniales immobilières : biens de l’État",
    headings: [
      "Ventes immobilières de l’État : 12 biens en vente.",
      "Ventes immobilières de l’État : 1 bien en vente.",
      "Ventes immobilières de l’État : aucun bien en vente référencé pour le moment.",
      "Ventes immobilières de l’État",
    ],
    search: "/sales?saleType=state",
  },
];

function landing(count: number, listed = Math.min(count, 30)): SaleLandingData {
  return {
    generatedAt: NOW.toISOString(),
    upcomingCount: count,
    sales: Array.from({ length: listed }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      department: index === 0 ? "33" : "2A",
      city: index === 0 ? "Bordeaux" : "Ajaccio",
      propertyType: "house",
      saleDate: "2026-11-20T13:00:00Z",
      startingPriceEur: 80_000 + index,
      surfaceM2: 90,
      venueType: index === 0 ? "tribunal" : "notary",
      status: "scheduled" as const,
    })),
  };
}

function titleOf(metadata: Metadata): string {
  return String(metadata.title);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  process.env.SITE_URL = "https://immojudis.com";
  mocks.load.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  delete process.env.SITE_URL;
});

describe.each(PAGES)("page $path", ({ key, path, module, title, headings, search }) => {
  it("est rendue à l'avance et rafraîchie toutes les heures, comme sa lecture", () => {
    expect(module.revalidate).toBe(3600);
    expect(module.revalidate).toBe(SALE_LANDING_REVALIDATE_SECONDS);
  });

  it("a son titre, sa description, sa canonique, et reste indexable à partir de 3 ventes", async () => {
    mocks.load.mockResolvedValue(landing(3));
    const metadata = await module.generateMetadata();
    expect(mocks.load).toHaveBeenCalledWith(key);
    expect(titleOf(metadata)).toBe(title);
    expect(title.length + TITLE_SUFFIX.length).toBeLessThanOrEqual(60);
    const description = String(metadata.description);
    expect(description.length).toBeGreaterThanOrEqual(120);
    expect(description.length).toBeLessThanOrEqual(158);
    expect(`${title} ${description}`).not.toMatch(COMPETITORS);
    expect(metadata.robots).toBeUndefined();
    expect(metadata.alternates?.canonical).toBe(path);
    expect(metadata.openGraph).toMatchObject({ url: path, siteName: "Immojudis" });
  });

  it("passe en noindex, follow sous 3 ventes, et quand la base n'a pas pu être lue", async () => {
    for (const data of [landing(2), landing(0), null]) {
      mocks.load.mockResolvedValue(data);
      const metadata = await module.generateMetadata();
      expect(metadata.robots).toEqual({ index: false, follow: true });
      expect(metadata.alternates?.canonical).toBe(path);
    }
  });

  it("accorde le titre-phrase au nombre de ventes", async () => {
    for (const [data, heading] of [
      [landing(12), headings[0]],
      [landing(1), headings[1]],
      [landing(0), headings[2]],
      [null, headings[3]],
    ] as const) {
      mocks.load.mockResolvedValue(data);
      render(await module.default());
      const h1 = screen.getAllByRole("heading", { level: 1 });
      expect(h1.map((node) => node.textContent)).toEqual([heading]);
      expect(heading).not.toMatch(COMPETITORS);
      cleanup();
    }
  });

  it("liste les prochaines ventes, avec leur département, et renvoie vers la recherche filtrée", async () => {
    mocks.load.mockResolvedValue(landing(45, 30));
    const { container } = render(await module.default());
    const list = screen.getByRole("region", { name: "Les prochaines ventes" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(30);
    expect(rows[0].textContent).toContain("Bordeaux (33)");
    expect(rows[1].textContent).toContain("Ajaccio (2A)");
    expect(rows[0].querySelector("a")!.getAttribute("href")).toBe(
      "/sales/00000000-0000-4000-8000-000000000000",
    );
    expect(list.textContent).toContain("Les 30 prochaines ventes sont listées ici");
    expect(
      screen
        .getByRole("link", { name: "Voir les 45 ventes dans la recherche" })
        .getAttribute("href"),
    ).toBe(search);
    // Fil d'Ariane et liste des ventes en données structurées.
    const jsonLd = Array.from(
      container.querySelectorAll('script[type="application/ld+json"]'),
      (script) => JSON.parse(script.textContent ?? "{}"),
    );
    expect(jsonLd.map((data) => data["@type"]).sort()).toEqual(["BreadcrumbList", "ItemList"]);
    const breadcrumb = jsonLd.find((data) => data["@type"] === "BreadcrumbList");
    expect(breadcrumb.itemListElement.at(-1).item).toBe(`https://immojudis.com${path}`);
    const itemList = jsonLd.find((data) => data["@type"] === "ItemList");
    expect(itemList.numberOfItems).toBe(30);
    expect(itemList.itemListElement[0].url).toBe(
      "https://immojudis.com/sales/00000000-0000-4000-8000-000000000000",
    );
  });

  it("renvoie vers les autres pages par type, les départements, le guide et les ressources", async () => {
    mocks.load.mockResolvedValue(landing(3));
    render(await module.default());
    const hrefs = screen.getAllByRole("link").map((link) => link.getAttribute("href"));
    const others = [
      "/maison-aux-encheres",
      "/appartement-aux-encheres",
      "/encheres-notariales",
      "/ventes-immobilieres-etat",
    ].filter((other) => other !== path);
    for (const href of [
      ...others,
      "/ventes-encheres-immobilieres",
      "/ventes-immobilieres-judiciaires",
      "/ressources",
    ]) {
      expect(hrefs, href).toContain(href);
    }
  });

  it("reste servie sans liste quand la base n'a pas pu être lue", async () => {
    mocks.load.mockResolvedValue(null);
    const { container } = render(await module.default());
    expect(screen.getByRole("status").textContent).toContain("momentanément indisponible");
    expect(container.querySelectorAll('script[type="application/ld+json"]')).toHaveLength(1);
    // Le bouton du haut de page et celui de la liste vide mènent à la recherche filtrée.
    for (const link of screen.getAllByRole("link", { name: "Ouvrir la recherche" })) {
      expect(link.getAttribute("href")).toBe(search);
    }
  });
});

describe("contenu propre à chaque page", () => {
  it("enchères notariales : distingue bougie, vente interactive et annonce classique", async () => {
    mocks.load.mockResolvedValue(landing(3));
    render(await notaryPage.default());
    const formules = screen.getByRole("region", {
      name: "Bougie, vente interactive ou annonce classique : trois façons de vendre chez le notaire",
    });
    expect(formules.textContent).toContain("La vente aux enchères à la bougie.");
    expect(formules.textContent).toContain("La vente notariale interactive.");
    expect(formules.textContent).toContain("Ce n’est pas une adjudication");
    // Les annonces classiques ne sont pas sur Immojudis : la page le dit et renvoie au site des notaires.
    expect(formules.textContent).toContain("Immojudis ne liste pas ces annonces");
    const notaries = within(formules).getByRole("link", { name: "immobilier.notaires.fr" });
    expect(notaries.getAttribute("href")).toBe("https://www.immobilier.notaires.fr/");
    expect(notaries.getAttribute("rel")).toBe("noopener noreferrer");
    // L'article existant sur les ventes notariales, dans le texte et dans « Pour comprendre ».
    const articleLinks = screen
      .getAllByRole("link")
      .filter(
        (link) =>
          link.getAttribute("href") ===
          "/ressources/ventes-notariales-domaniales-differences-tribunal",
      );
    expect(articleLinks.length).toBe(2);
  });

  it("ventes de l'État : ne promet pas d'enchères et renvoie ailleurs pour le mobilier", async () => {
    mocks.load.mockResolvedValue(landing(3));
    render(await statePage.default());
    const main = screen.getByRole("main");
    expect(main.textContent).toContain("Toutes ces ventes ne sont pas des enchères");
    expect(main.textContent).toContain(
      "un appel d’offres ou une vente amiable n’est pas une vente",
    );
    expect(main.textContent).toContain("AGRASC");
    expect(main.textContent).toContain("ne sont pas sur Immojudis");
    const domaine = screen.getByRole("link", { name: "encheres-domaine.gouv.fr" });
    expect(domaine.getAttribute("href")).toBe("https://encheres-domaine.gouv.fr/");
    expect(
      screen
        .getAllByRole("link")
        .some(
          (link) =>
            link.getAttribute("href") ===
            "/ressources/ventes-notariales-domaniales-differences-tribunal",
        ),
    ).toBe(true);
  });

  it.each([
    [housePage, "Acheter une maison aux enchères : les étapes", "/appartement-aux-encheres"],
    [apartmentPage, "Acheter un appartement aux enchères : les étapes", "/maison-aux-encheres"],
  ] as const)("maison et appartement : un court guide d'achat (%#)", async (page, step, other) => {
    mocks.load.mockResolvedValue(landing(3));
    render(await page.default());
    const guide = screen.getByRole("region", { name: step });
    expect(within(guide).getAllByRole("listitem")).toHaveLength(5);
    expect(guide.textContent).toContain("avocat inscrit au barreau du tribunal compétent");
    expect(
      within(guide)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual(["/simulateur-frais-encheres", "/ventes-immobilieres-judiciaires", "/ressources"]);
    expect(screen.getAllByRole("link").map((link) => link.getAttribute("href"))).toContain(other);
  });
});
