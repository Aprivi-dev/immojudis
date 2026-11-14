// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
  // Même forme de digest que le vrai : NEXT_REDIRECT;<type>;<url>;<statut>;
  permanentRedirect: (url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), {
      digest: `NEXT_REDIRECT;replace;${url};308;`,
    });
  },
}));

import { DEPARTMENT_PAGES_MAX_DURATION_SECONDS } from "@/lib/department-pages";
import { DEPARTMENT_CATALOGUE_REVALIDATE_SECONDS } from "@/lib/department-pages.server";
import Page, { generateMetadata, generateStaticParams, maxDuration, revalidate } from "./page";

/** Horloge fixe : les ventes ci-dessous sont à venir à cette date, quel que soit le jour réel. */
const NOW = new Date("2026-10-15T08:00:00Z");

function sale(id: string, overrides: Partial<DepartmentSaleInput> = {}): DepartmentSaleInput {
  return {
    id,
    department: "33",
    city: "Bordeaux",
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
  return { params: Promise.resolve({ departement: slug }) };
}

const THREE = [sale("a"), sale("b", { propertyType: "house" }), sale("c", { city: "Mérignac" })];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
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
  vi.useRealTimers();
  cleanup();
  delete process.env.SITE_URL;
});

describe("page d'un département : génération", () => {
  it("est produite à la première demande puis rafraîchie toutes les heures", async () => {
    expect(await generateStaticParams()).toEqual([]);
    expect(revalidate).toBe(3600);
    expect(revalidate).toBe(DEPARTMENT_CATALOGUE_REVALIDATE_SECONDS);
  });

  it("relève la durée maximale du rendu, qui peut lire tout le catalogue", () => {
    expect(maxDuration).toBe(60);
    expect(maxDuration).toBe(DEPARTMENT_PAGES_MAX_DURATION_SECONDS);
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

  it("redirige en 308 l'adresse par numéro vers l'adresse par nom, sans lire la base", async () => {
    for (const [number, path] of [
      ["13", "/ventes-encheres-immobilieres/bouches-du-rhone"],
      ["01", "/ventes-encheres-immobilieres/ain"],
      ["2A", "/ventes-encheres-immobilieres/corse-du-sud"],
      ["2b", "/ventes-encheres-immobilieres/haute-corse"],
      ["971", "/ventes-encheres-immobilieres/guadeloupe"],
    ] as const) {
      await expect(Page(params(number)), number).rejects.toMatchObject({
        digest: `NEXT_REDIRECT;replace;${path};308;`,
      });
      expect((await generateMetadata(params(number))).robots, number).toEqual({
        index: false,
        follow: true,
      });
    }
    // Un numéro qui ne désigne aucun département reste une page introuvable.
    await expect(Page(params("97"))).rejects.toMatchObject({
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
    mocks.catalogue.mockResolvedValue(aggregateDepartments(THREE, NOW));
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
    mocks.catalogue.mockResolvedValue(aggregateDepartments(THREE.slice(0, 2), NOW));
    const metadata = await generateMetadata(params("gironde"));
    expect(metadata.robots).toEqual({ index: false, follow: true });
    // La page reste adressable : titre et canonical sont posés.
    expect(metadata.alternates?.canonical).toBe("/ventes-encheres-immobilieres/gironde");
  });

  it("passe en noindex pour un département sans aucune vente, et reste servie", async () => {
    mocks.catalogue.mockResolvedValue(aggregateDepartments(THREE, NOW));
    const metadata = await generateMetadata(params("ain"));
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(String(metadata.description)).toContain("Aucune vente");
    const { container } = render(await Page(params("ain")));
    expect(container.textContent).toContain("Aucune vente à venir n’est référencée");
  });
});

describe("page d'un département : contenu", () => {
  it("montre le titre-phrase, les chiffres calculés sur nos ventes, la répartition et la liste", async () => {
    mocks.catalogue.mockResolvedValue(aggregateDepartments(THREE, NOW));
    const { container } = render(await Page(params("gironde")));

    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual([
      "3 ventes immobilières aux enchères à venir en Gironde (33).",
    ]);
    expect(container.querySelector("header")?.textContent).toContain(
      "Ventes aux enchères · Nouvelle-Aquitaine",
    );
    const figures = screen.getByRole("region", { name: "Les chiffres du département" });
    expect(figures.textContent).toContain("Ventes à venir3");
    expect(figures.textContent).toContain("au 15 octobre 2026");
    expect(figures.textContent).toContain("10 novembre 2026");
    expect(figures.textContent).toMatch(/80\s000\s€/);

    const types = screen.getByRole("region", { name: "Types de bien" });
    expect(
      within(types)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Appartement2 ventes", "Maison1 vente"]);
    const bars = [...types.querySelectorAll<HTMLElement>("[aria-hidden] > span")];
    expect(bars.map((bar) => bar.style.width)).toEqual(["100%", "50%"]);

    const list = screen.getByRole("region", { name: "Les prochaines ventes" });
    const links = within(list)
      .getAllByRole("link")
      .filter((link) => link.getAttribute("href")?.startsWith("/sales/"));
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/sales/a",
      "/sales/b",
      "/sales/c",
    ]);
    expect(container.textContent).toContain("Mérignac");
  });

  it("transmet la page du département à la fiche dans le navigateur seulement (« Retour aux ventes du département »)", async () => {
    mocks.catalogue.mockResolvedValue(aggregateDepartments(THREE, NOW));
    render(await Page(params("gironde")));
    const list = screen.getByRole("region", { name: "Les prochaines ventes" });
    const link = within(list)
      .getAllByRole("link")
      .find((candidate) => candidate.getAttribute("href")?.startsWith("/sales/"))!;
    // HTML du serveur : l'adresse canonique de la fiche, sans origine.
    expect(link.getAttribute("href")).toBe("/sales/a");
    fireEvent.pointerEnter(link);
    expect(link.getAttribute("href")).toBe(
      "/sales/a?from=%2Fventes-encheres-immobilieres%2Fgironde",
    );
  });

  it("dit « audience » et « mise à prix » pour le tribunal, avec la médiane des ventes au tribunal", async () => {
    mocks.catalogue.mockResolvedValue(aggregateDepartments(THREE, NOW));
    render(await Page(params("gironde")));
    const figures = screen.getByRole("region", { name: "Les chiffres du département" });
    expect(figures.textContent).toContain("Prochaine audience");
    expect(figures.textContent).toContain("Mise à prix médiane au tribunal");
    expect(figures.textContent).toContain("sur 3 ventes au tribunal");
    // Le jour et l'heure de la prochaine audience (heure de Paris).
    expect(figures.textContent).toContain("mardi, à 14 h 00");
    const list = screen.getByRole("region", { name: "Les prochaines ventes" });
    expect(list.textContent).toContain("audience à 14 h 00");
    expect(list.textContent).toContain("Mise à prix");
    expect(list.textContent).toContain("Au tribunal");
    expect(list.textContent).not.toContain("Prix publié");
  });

  it("n'emploie ni « audience » ni « mise à prix » pour les ventes hors tribunal", async () => {
    mocks.catalogue.mockResolvedValue(
      aggregateDepartments(
        [
          sale("n", { venueType: "notary", saleDate: "2026-11-02T10:00:00Z" }),
          sale("s", { venueType: "state", saleDate: "2026-11-03T10:00:00Z" }),
          sale("u", { venueType: null, saleDate: "2026-11-04T00:00:00Z", startingPriceEur: null }),
        ],
        NOW,
      ),
    );
    render(await Page(params("gironde")));
    const figures = screen.getByRole("region", { name: "Les chiffres du département" });
    expect(figures.textContent).toContain("Prochaine date de vente");
    expect(figures.textContent).not.toContain("Prochaine audience");
    // Aucune vente au tribunal : pas de médiane inventée à partir des prix publiés.
    expect(figures.textContent).toContain("Non communiquée");
    expect(figures.textContent).toContain("aucune vente au tribunal chiffrée");
    const list = screen.getByRole("region", { name: "Les prochaines ventes" });
    const text = list.textContent ?? "";
    expect(text).toContain("séance à 11 h 00");
    expect(text).toContain("échéance à 11 h 00");
    expect(text).toContain("vente, heure à confirmer");
    expect(text).toContain("Chez le notaire");
    expect(text).toContain("Vente de l’État");
    expect(text).not.toContain("audience");
    expect(text).not.toContain("Mise à prix");
    expect(text.match(/Prix publié/g)).toHaveLength(3);
    expect(text).toContain("Non communiqué");
  });

  it("ne présente pas une vente reportée comme la prochaine audience", async () => {
    mocks.catalogue.mockResolvedValue(
      aggregateDepartments(
        [
          sale("r", { status: "postponed", saleDate: "2026-10-20T10:00:00Z" }),
          sale("a", { saleDate: "2026-12-01T10:00:00Z" }),
        ],
        NOW,
      ),
    );
    render(await Page(params("gironde")));
    const figures = screen.getByRole("region", { name: "Les chiffres du département" });
    expect(figures.textContent).toContain("1er décembre 2026");
    expect(figures.textContent).not.toContain("20 octobre 2026");
    const list = screen.getByRole("region", { name: "Les prochaines ventes" });
    expect(list.textContent).toContain("Vente reportée · nouvelle date à confirmer");
    expect(list.textContent).not.toContain("audience à 12 h 00");
    // La vente reportée va dans un dernier groupe, sans pavé de date.
    expect(
      within(list)
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(["Semaine du 30 novembre", "Date à confirmer"]);
  });

  it("regroupe les ventes par semaine et marque la vente du jour", async () => {
    mocks.catalogue.mockResolvedValue(
      aggregateDepartments(
        [
          sale("t", { saleDate: "2026-10-15T10:00:00Z" }),
          sale("w", { saleDate: "2026-10-18T10:00:00Z" }),
          sale("n", { saleDate: "2026-10-19T10:00:00Z" }),
          sale("y", { saleDate: "2027-01-05T10:00:00Z" }),
        ],
        NOW,
      ),
    );
    render(await Page(params("gironde")));
    const list = screen.getByRole("region", { name: "Les prochaines ventes" });
    expect(
      within(list)
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(["Semaine en cours", "Semaine du 19 octobre", "Semaine du 4 janvier 2027"]);
    const today = within(list).getByRole("link", { name: /15\s*oct\./ });
    expect(today.textContent).toContain("Aujourd’hui");
    expect(within(list).getAllByText("Aujourd’hui")).toHaveLength(1);
    const figures = screen.getByRole("region", { name: "Les chiffres du département" });
    expect(figures.textContent).toContain("aujourd’hui, à 12 h 00");
  });

  it("propose à un visiteur « Recevoir les nouvelles ventes de ce secteur » via la connexion", async () => {
    mocks.catalogue.mockResolvedValue(aggregateDepartments(THREE, NOW));
    render(await Page(params("gironde")));
    const cta = screen.getByRole("link", { name: "Recevoir les nouvelles ventes de ce secteur" });
    // Motif « alerte », puis retour sur la confirmation avec le département choisi.
    expect(cta.getAttribute("href")).toBe(
      "/login?redirect=%2Falertes%2Fcreer%3Fdepartment%3D33&mode=investor&reason=alerte",
    );
    // L'encart marine de la colonne, que le bouton du haut de page fait atteindre.
    const panel = screen.getByRole("region", {
      name: "Être prévenu des nouvelles ventes en Gironde",
    });
    expect(panel.className).toContain("bg-brand-navy");
    expect(panel.closest("#alerte")).not.toBeNull();
    // La cadence réelle (collecte au plus toutes les 12 heures, alertes évaluées chaque jour), pas
    // une promesse d'immédiateté.
    expect(panel.textContent).toContain(
      "Les sources sont relues jusqu’à deux fois par jour et vos alertes sont comparées au catalogue chaque jour",
    );
    expect(panel.textContent).not.toContain("dès qu’elles sont publiées");
    // Sur la page d'un département, la ligne d'une vente ne répète pas le numéro du département.
    expect(screen.getByRole("region", { name: "Les prochaines ventes" }).textContent).not.toContain(
      "(33)",
    );
    expect(
      screen.getByRole("link", { name: "Être prévenu des nouvelles ventes" }).getAttribute("href"),
    ).toBe("#alerte");
    // Aucune alerte ni email n'est créé par la page elle-même.
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("renvoie vers la recherche du département et vers les tribunaux concernés", async () => {
    mocks.catalogue.mockResolvedValue(aggregateDepartments(THREE, NOW));
    render(await Page(params("gironde")));
    expect(
      screen.getByRole("link", { name: "Voir les 3 ventes sur la carte" }).getAttribute("href"),
    ).toBe("/sales?department=33");
    expect(
      screen.getByRole("link", { name: /Voir les 3 ventes en Gironde/ }).getAttribute("href"),
    ).toBe("/sales?department=33");

    const tribunals = screen.getByRole("region", { name: "Tribunaux et ventes" });
    expect(tribunals.textContent).toContain("9 ventes");
    const hrefs = within(tribunals)
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    expect(hrefs).toContain("/sales?tribunal=TJ+Bordeaux");
    expect(hrefs).toContain("/tribunaux");
    // Le tribunal de Paris n'appartient pas à la Gironde.
    expect(hrefs).not.toContain("/sales?tribunal=TJ+Paris");
  });

  it("ajoute « Pour comprendre » (le guide et deux articles) et les départements limitrophes en pastilles", async () => {
    mocks.catalogue.mockResolvedValue(
      aggregateDepartments(
        [...THREE, sale("l1", { department: "40" }), sale("l2", { department: "40" })],
        NOW,
      ),
    );
    render(await Page(params("gironde")));

    const block = screen.getByRole("region", { name: "Pour comprendre" });
    const hrefs = within(block)
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    expect(hrefs[0]).toBe("/ventes-immobilieres-judiciaires");
    const articles = hrefs.filter((href) => href?.startsWith("/ressources/"));
    expect(articles).toHaveLength(2);
    expect(new Set(articles).size).toBe(2);
    expect(block.textContent).toContain("min de lecture");

    // Charente-Maritime, Dordogne, Landes et Lot-et-Garonne touchent la Gironde.
    const nearby = screen.getByRole("region", { name: "Départements limitrophes" });
    expect(
      within(nearby)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual([
      "/ventes-encheres-immobilieres/charente-maritime",
      "/ventes-encheres-immobilieres/dordogne",
      "/ventes-encheres-immobilieres/landes",
      "/ventes-encheres-immobilieres/lot-et-garonne",
      "/ventes-encheres-immobilieres",
    ]);
    expect(within(nearby).getByRole("link", { name: /^Landes/ }).textContent).toBe(
      "Landes2 ventes à venir",
    );
    expect(within(nearby).getByRole("link", { name: /^Dordogne/ }).textContent).toBe(
      "Dordogne0 vente à venir",
    );
  });

  it("garde « Pour comprendre » et la liste des départements sans voisin pour l'outre-mer", async () => {
    mocks.catalogue.mockResolvedValue(aggregateDepartments(THREE, NOW));
    render(await Page(params("la-reunion")));

    const block = screen.getByRole("region", { name: "Pour comprendre" });
    expect(within(block).getAllByRole("link").length).toBe(3);
    expect(screen.queryByRole("region", { name: "Départements limitrophes" })).toBeNull();
    const others = screen.getByRole("region", { name: "Autres départements" });
    expect(within(others).getByRole("link", { name: "Tous les départements" })).toBeTruthy();
    expect(document.body.textContent).toContain("Ventes aux enchères · Outre-mer");
  });

  it("garde la page quand l'activité des tribunaux est indisponible", async () => {
    mocks.catalogue.mockResolvedValue(aggregateDepartments(THREE, NOW));
    mocks.tribunals.mockResolvedValue({ status: "error" });
    render(await Page(params("gironde")));
    const tribunals = screen.getByRole("region", { name: "Tribunaux et ventes" });
    expect(within(tribunals).getByRole("link", { name: /tous les tribunaux/ })).toBeTruthy();
  });

  it("liste les 30 prochaines ventes et renvoie vers la recherche pour les autres", async () => {
    const many = Array.from({ length: 45 }, (_, index) =>
      sale(`s-${String(index).padStart(2, "0")}`),
    );
    mocks.catalogue.mockResolvedValue(aggregateDepartments(many, NOW));
    render(await Page(params("gironde")));
    const list = screen.getByRole("region", { name: "Les prochaines ventes" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(30);
    expect(list.textContent).toContain("Les 30 prochaines ventes sont listées ici");
    expect(
      within(list).getByRole("link", { name: "la recherche du département" }).getAttribute("href"),
    ).toBe("/sales?department=33");
    expect(within(list).getByRole("link", { name: "Voir les 45 ventes en Gironde" })).toBeTruthy();
  });

  it("ordonne la page : fil d'Ariane, titre, chiffres, boutons, ventes, puis la colonne (alerte, répartition)", async () => {
    mocks.catalogue.mockResolvedValue(aggregateDepartments(THREE, NOW));
    const { container } = render(await Page(params("gironde")));
    const position = (node: Element) => Array.from(container.querySelectorAll("*")).indexOf(node);
    const ordered = [
      screen.getByRole("navigation", { name: "Fil d’Ariane" }),
      screen.getByRole("heading", { level: 1 }),
      screen.getByRole("region", { name: "Les chiffres du département" }),
      screen.getByRole("link", { name: "Voir les 3 ventes sur la carte" }),
      screen.getByRole("region", { name: "Les prochaines ventes" }),
      screen.getByRole("link", { name: /Voir les 3 ventes en Gironde/ }),
      screen.getByRole("region", { name: "Tribunaux et ventes" }),
      screen.getByRole("region", { name: "Pour comprendre" }),
      screen.getByRole("link", { name: "Recevoir les nouvelles ventes de ce secteur" }),
      screen.getByRole("region", { name: "Types de bien" }),
      screen.getByRole("region", { name: "Communes les plus présentes" }),
      screen.getByRole("region", { name: "Départements limitrophes" }),
    ].map(position);
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
    expect(new Set(ordered).size).toBe(ordered.length);
    expect(screen.getByRole("complementary", { name: "En un coup d’œil" })).toBeTruthy();
  });

  it("génère « Communes les plus présentes » à partir des ventes, avec un lien vers la recherche", async () => {
    mocks.catalogue.mockResolvedValue(aggregateDepartments(THREE, NOW));
    render(await Page(params("gironde")));
    const block = screen.getByRole("region", { name: "Communes les plus présentes" });
    expect(
      within(block)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Bordeaux2 ventes", "Mérignac1 vente"]);
    expect(within(block).getByRole("link", { name: "Mérignac" }).getAttribute("href")).toBe(
      "/sales?department=33&city=M%C3%A9rignac",
    );
    expect(block.textContent).toContain("Les nombres sont indicatifs");
    // Des données, pas une affirmation juridique.
    expect(block.textContent).not.toMatch(/doit|obligatoire|garanti/i);
  });

  it("compte une seule fois un arrondissement écrit de deux façons", async () => {
    mocks.catalogue.mockResolvedValue(
      aggregateDepartments(
        [
          sale("p1", { department: "75", city: "Paris 13ème" }),
          sale("p2", { department: "75", city: "Paris 13e Arrondissement" }),
          sale("p3", { department: "75", city: "PARIS 13E" }),
          sale("p4", { department: "75", city: "Paris 15e Arrondissement" }),
        ],
        NOW,
      ),
    );
    render(await Page(params("paris")));
    const block = screen.getByRole("region", { name: "Communes les plus présentes" });
    expect(
      within(block)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Paris 13e3 ventes", "Paris 15e1 vente"]);
    expect(within(block).getByRole("link", { name: "Paris 13e" }).getAttribute("href")).toBe(
      "/sales?department=75&city=Paris+13e",
    );
    const list = screen.getByRole("region", { name: "Les prochaines ventes" });
    expect(list.textContent).not.toMatch(/ème|Arrondissement|13E/);
  });

  it("n'affiche pas ce bloc quand une seule commune est concernée", async () => {
    mocks.catalogue.mockResolvedValue(aggregateDepartments([sale("a"), sale("b")], NOW));
    render(await Page(params("gironde")));
    expect(screen.queryByRole("region", { name: "Communes les plus présentes" })).toBeNull();
  });

  it("met les trois chiffres sur une seule ligne à partir de la tablette", async () => {
    mocks.catalogue.mockResolvedValue(aggregateDepartments(THREE, NOW));
    render(await Page(params("gironde")));
    const figures = screen.getByRole("region", { name: "Les chiffres du département" });
    const list = figures.querySelector("dl")!;
    expect(list.className).toContain("sm:grid-cols-3");
    expect(list.children).toHaveLength(3);
  });

  it("garde les trois chiffres compacts sur mobile : une ligne par chiffre, libellé à gauche", async () => {
    mocks.catalogue.mockResolvedValue(aggregateDepartments(THREE, NOW));
    render(await Page(params("gironde")));
    const figures = screen.getByRole("region", { name: "Les chiffres du département" });
    for (const card of figures.querySelector("dl")!.children) {
      // Libellé et chiffre côte à côte sous 640 px, puis la carte en bloc dès la tablette.
      expect(card.className).toContain("grid-cols-[minmax(0,1fr)_auto]");
      expect(card.className).toContain("sm:block");
      const value = card.querySelector("dd")!;
      expect(value.className).toContain("text-xl");
      expect(value.className).toContain("sm:text-[1.75rem]");
    }
  });

  it("pose le titre avec l'échelle commune des titres de page", async () => {
    mocks.catalogue.mockResolvedValue(aggregateDepartments(THREE, NOW));
    render(await Page(params("gironde")));
    expect(screen.getByRole("heading", { level: 1 }).className).toContain("sm:text-[2.5rem]");
  });

  it("garde un texte d'introduction générique, sans conseil", async () => {
    mocks.catalogue.mockResolvedValue(aggregateDepartments(THREE, NOW));
    const { container } = render(await Page(params("gironde")));
    const intro = container.querySelector("header")?.textContent ?? "";
    expect(intro).toContain("catalogue public au 15 octobre 2026");
    expect(intro).toContain("pièces officielles font foi");
    expect(intro).not.toMatch(/investir|rentab|opportunit/i);
    expect(container.textContent).toContain("ne constituent pas un conseil juridique");
  });
});

describe("page d'un département : données structurées", () => {
  it("émet un fil d'Ariane et la liste des ventes en adresses absolues", async () => {
    mocks.catalogue.mockResolvedValue(aggregateDepartments(THREE, NOW));
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
    mocks.catalogue.mockResolvedValue(aggregateDepartments(THREE, NOW));
    const { container } = render(await Page(params("ain")));
    const types = [...container.querySelectorAll('script[type="application/ld+json"]')].map(
      (script) => JSON.parse(script.textContent ?? "{}")["@type"],
    );
    expect(types).toEqual(["BreadcrumbList"]);
  });
});
