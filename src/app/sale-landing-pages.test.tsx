// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

import { saleDetailPath } from "@/lib/navigation";
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
  /** Articles de « Pour comprendre », après le guide des ventes judiciaires. */
  articles: string[];
}> = [
  {
    key: "house",
    path: "/maison-aux-encheres",
    module: housePage,
    title: "Maison aux enchères : les ventes à venir",
    headings: [
      "12 maisons en vente aux enchères ou sur offres, à venir.",
      "1 maison en vente aux enchères ou sur offres, à venir.",
      "Aucune maison en vente aux enchères ou sur offres à venir pour le moment.",
      "Maisons en vente aux enchères ou sur offres",
    ],
    search: "/sales?homeTypes=house",
    articles: [
      "acheter-maison-aux-encheres-etapes-frais-risques",
      "adjudication-immobiliere-vente-par-adjudication",
      "acheter-bien-occupe-encheres",
      "frais-vente-encheres-judiciaire",
    ],
  },
  {
    key: "apartment",
    path: "/appartement-aux-encheres",
    module: apartmentPage,
    title: "Appartement aux enchères : les ventes à venir",
    headings: [
      "12 appartements en vente aux enchères ou sur offres, à venir.",
      "1 appartement en vente aux enchères ou sur offres, à venir.",
      "Aucun appartement en vente aux enchères ou sur offres à venir pour le moment.",
      "Appartements en vente aux enchères ou sur offres",
    ],
    search: "/sales?homeTypes=apartment",
    articles: [
      "copropriete-encheres-charges-assemblees",
      "acheter-maison-aux-encheres-etapes-frais-risques",
      "adjudication-immobiliere-vente-par-adjudication",
      "acheter-bien-occupe-encheres",
    ],
  },
  {
    key: "notary",
    path: "/encheres-notariales",
    module: notaryPage,
    title: "Enchères notariales : biens immobiliers à venir",
    headings: [
      "Enchères et ventes interactives des notaires : 12 ventes immobilières à venir.",
      "Enchères et ventes interactives des notaires : 1 vente immobilière à venir.",
      "Enchères et ventes interactives des notaires : aucune vente à venir pour le moment.",
      "Enchères et ventes interactives des notaires",
    ],
    search: "/sales?saleType=notary",
    articles: [
      "immobilier-notaires-annonces-vente-interactive-encheres",
      "ventes-notariales-domaniales-differences-tribunal",
      "encheres-immobilieres-en-ligne-distance",
      "frais-vente-encheres-judiciaire",
    ],
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
    articles: [
      "ventes-domaniales-etat-biens-immobiliers-mobiliers",
      "ventes-notariales-domaniales-differences-tribunal",
    ],
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
  vi.unstubAllEnvs();
});

describe.each(PAGES)("page $path", ({ key, path, module, title, headings, search, articles }) => {
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
    const first = rows[0].querySelector("a")!;
    expect(first.getAttribute("href")).toBe("/sales/00000000-0000-4000-8000-000000000000");
    // « Retour » de la fiche : la recherche filtrée de la page, ajoutée à l'approche du lien.
    fireEvent.focus(first);
    expect(first.getAttribute("href")).toBe(
      saleDetailPath("00000000-0000-4000-8000-000000000000", search),
    );
    expect(first.getAttribute("href")).toContain("?from=");
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

  it("propose dans « Pour comprendre » le guide, puis au plus 4 articles choisis pour la page", async () => {
    mocks.load.mockResolvedValue(landing(3));
    render(await module.default());
    const understand = screen.getByRole("region", { name: "Pour comprendre" });
    const hrefs = within(understand)
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    expect(hrefs).toEqual([
      "/ventes-immobilieres-judiciaires",
      ...articles.map((slug) => `/ressources/${slug}`),
      "/ressources",
    ]);
    expect(articles.length).toBeLessThanOrEqual(4);
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
    // Avis juridique du 14/11 : pas de vente « en ligne » déduite de l'art. R. 3211-2, plateforme
    // non nommée, sources de l'État sans le qualificatif « publiques ».
    expect(main.textContent).toContain(
      "Une annonce de l’État peut mener à une adjudication publique, à un appel d’offres ou à une vente de gré à gré. Certaines cessions passent par une plateforme d’enchères en ligne, où l’offre retenue n’est pas forcément la plus élevée.",
    );
    expect(main.textContent).not.toContain("peut donc mener");
    expect(main.textContent).not.toContain("en salle ou en ligne");
    expect(main.textContent).toContain("d’autres sources, comme les biens confisqués");
    expect(main.textContent).not.toContain("sources publiques");
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
    expect(guide.textContent).toContain(
      "de la mise à prix, au moins 3\u202f000\u00a0€ (art. R. 322-41 du Code des procédures civiles d’exécution)",
    );
    expect(guide.textContent).toContain(
      "l’État vend par adjudication publique ou cession amiable, le plus souvent sur appel d’offres, et de gré à gré dans des cas limités ; les biens confisqués sont vendus par l’AGRASC.",
    );
    expect(
      within(guide)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual(["/simulateur-frais-encheres", "/ventes-immobilieres-judiciaires", "/ressources"]);
    expect(screen.getAllByRole("link").map((link) => link.getAttribute("href"))).toContain(other);
  });

  it.each([
    [housePage, "La plupart sont vendues aux enchères ; certaines le sont sur offres"],
    [apartmentPage, "La plupart sont vendus aux enchères ; certains le sont sur offres"],
  ] as const)(
    "maison et appartement : le total compte aussi les ventes sur offres, et l'introduction le dit (%#)",
    async (page, sentence) => {
      mocks.load.mockResolvedValue(landing(3));
      render(await page.default());
      expect(screen.getByRole("main").textContent).toContain(
        `${sentence} (ventes notariales interactives, appels d’offres de l’État) : chaque fiche indique le type de vente.`,
      );
    },
  );
});

describe("interrupteur des ventes notariales et de l'État coupé", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_NOTARY_STATE_PILOTS_ENABLED", "false");
  });

  it.each([notaryPage, statePage])(
    "les pages des notaires et de l'État restent consultables, en noindex, follow (%#)",
    async (page) => {
      mocks.load.mockResolvedValue(landing(40));
      const metadata = await page.generateMetadata();
      expect(metadata.robots).toEqual({ index: false, follow: true });
      render(await page.default());
      expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    },
  );

  it("les autres pages n'y renvoient plus", async () => {
    mocks.load.mockResolvedValue(landing(40));
    expect((await housePage.generateMetadata()).robots).toBeUndefined();
    render(await housePage.default());
    const others = screen.getByRole("region", { name: "Autres ventes" });
    const hrefs = within(others)
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    expect(hrefs).toContain("/appartement-aux-encheres");
    expect(hrefs).not.toContain("/encheres-notariales");
    expect(hrefs).not.toContain("/ventes-immobilieres-etat");
  });
});
