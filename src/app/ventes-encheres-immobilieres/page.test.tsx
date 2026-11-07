// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  aggregateDepartments,
  DEPARTMENT_PAGES_MAX_DURATION_SECONDS,
  DEPARTMENTS,
  type DepartmentSaleInput,
} from "@/lib/department-pages";

const mocks = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock("@/lib/department-pages.server", () => ({ tryLoadDepartmentCatalogue: mocks.load }));

import Page, { generateMetadata, maxDuration, revalidate } from "./page";

function sale(id: string, department: string): DepartmentSaleInput {
  return {
    id,
    department,
    city: "Ville",
    propertyType: "house",
    saleDate: "2026-11-10T13:00:00Z",
    startingPriceEur: 70_000,
    surfaceM2: 80,
    venueType: "tribunal",
    status: "scheduled",
  };
}

const CATALOGUE = aggregateDepartments([
  sale("a", "33"),
  sale("b", "33"),
  sale("c", "33"),
  sale("d", "75"),
]);

beforeEach(() => {
  process.env.SITE_URL = "https://immojudis.com";
  mocks.load.mockReset();
});
afterEach(() => {
  cleanup();
  delete process.env.SITE_URL;
});

describe("index des ventes par département", () => {
  it("est rafraîchi toutes les 5 minutes, comme /tribunaux", () => {
    expect(revalidate).toBe(300);
  });

  it("relève la durée maximale du rendu, qui peut lire tout le catalogue", () => {
    expect(maxDuration).toBe(60);
    expect(maxDuration).toBe(DEPARTMENT_PAGES_MAX_DURATION_SECONDS);
  });

  it("liste les 101 départements avec leurs comptes, un lien chacun", async () => {
    mocks.load.mockResolvedValue({ status: "ok", catalogue: CATALOGUE });
    render(await Page());
    const section = screen.getByRole("region", { name: "Tous les départements" });
    const links = within(section).getAllByRole("link");
    expect(links).toHaveLength(DEPARTMENTS.length);
    const gironde = links.find(
      (link) => link.getAttribute("href") === "/ventes-encheres-immobilieres/gironde",
    );
    expect(gironde?.textContent).toContain("Gironde");
    expect(gironde?.textContent).toContain("3 ventes à venir");
    const paris = links.find(
      (link) => link.getAttribute("href") === "/ventes-encheres-immobilieres/paris",
    );
    expect(paris?.textContent).toContain("1 vente à venir");
    const ain = links.find(
      (link) => link.getAttribute("href") === "/ventes-encheres-immobilieres/ain",
    );
    expect(ain?.textContent).toContain("Aucune vente à venir");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("fait du total le titre : ventes à venir et départements qui en ont", async () => {
    mocks.load.mockResolvedValue({ status: "ok", catalogue: CATALOGUE });
    render(await Page());
    const title = screen.getByRole("heading", { level: 1 });
    expect(title.textContent).toBe(
      "4 ventes immobilières aux enchères à venir, dans 2 départements.",
    );
    // Les deux chiffres sont surlignés.
    expect([...title.querySelectorAll("span")].map((span) => span.textContent)).toEqual(["4", "2"]);
  });

  it("accorde le titre au singulier et dit quand le catalogue est vide", async () => {
    mocks.load.mockResolvedValue({
      status: "ok",
      catalogue: aggregateDepartments([sale("a", "33")]),
    });
    const { unmount } = render(await Page());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "1 vente immobilière aux enchères à venir, dans 1 département.",
    );
    unmount();
    mocks.load.mockResolvedValue({ status: "ok", catalogue: aggregateDepartments([]) });
    render(await Page());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Aucune vente immobilière aux enchères à venir pour le moment.",
    );
    // Sans vente, ni carte ni classement.
    expect(screen.queryByRole("region", { name: "Où se trouvent les ventes" })).toBeNull();
  });

  it("dessine un rond par département de métropole, lien vers sa page, Paris dans le médaillon", async () => {
    mocks.load.mockResolvedValue({ status: "ok", catalogue: CATALOGUE });
    render(await Page());
    const map = screen.getByRole("region", { name: "Où se trouvent les ventes" });
    const group = within(map).getByRole("group");
    expect(group.getAttribute("aria-label")).toContain("La liste détaillée");
    const dots = [...group.querySelectorAll<HTMLAnchorElement>("a[data-code]")];
    // 96 départements de métropole ; l'outre-mer n'est que dans la liste.
    expect(dots).toHaveLength(96);
    const dot = (slug: string) =>
      group.querySelector<HTMLAnchorElement>(`a[href="/ventes-encheres-immobilieres/${slug}"]`)!;
    expect(dot("gironde").getAttribute("aria-label")).toBe("Gironde (33) : 3 ventes à venir");
    expect(dot("gironde").textContent).toContain("Gironde (33) · 3 ventes à venir");
    expect(dot("ain").getAttribute("aria-label")).toBe("Ain (01) : aucune vente à venir");
    // Les plus grands ronds d'abord, pour que les petits restent visibles par-dessus.
    expect(dots.slice(0, 2).map((link) => link.dataset.code)).toEqual(["33", "75"]);
    // Positions : le Nord au-dessus de la Gironde, Paris agrandi dans le médaillon en bas à gauche.
    const top = (slug: string) => parseFloat(dot(slug).style.top);
    const left = (slug: string) => parseFloat(dot(slug).style.left);
    expect(top("nord")).toBeLessThan(top("gironde"));
    expect(left("finistere")).toBeLessThan(left("bas-rhin"));
    expect(top("paris")).toBeGreaterThan(64);
    expect(left("paris")).toBeLessThan(28);
  });

  it("classe les départements les plus actifs, avec une barre proportionnelle", async () => {
    mocks.load.mockResolvedValue({ status: "ok", catalogue: CATALOGUE });
    render(await Page());
    const top = screen.getByRole("region", { name: "Les départements les plus actifs" });
    const items = within(top).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "1Gironde (33)3 ventes à venir",
      "2Paris (75)1 vente à venir",
    ]);
    const bars = [...top.querySelectorAll<HTMLElement>("[aria-hidden] > span")];
    expect(bars.map((bar) => bar.style.width)).toEqual(["100%", "33.3%"]);
  });

  it("garde au plus dix départements dans le classement", async () => {
    const codes = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];
    mocks.load.mockResolvedValue({
      status: "ok",
      catalogue: aggregateDepartments(codes.map((code) => sale(`s-${code}`, code))),
    });
    render(await Page());
    const top = screen.getByRole("region", { name: "Les départements les plus actifs" });
    expect(within(top).getAllByRole("listitem")).toHaveLength(10);
  });

  it("groupe la liste par région, avec le total de la région", async () => {
    mocks.load.mockResolvedValue({ status: "ok", catalogue: CATALOGUE });
    render(await Page());
    const section = screen.getByRole("region", { name: "Tous les départements" });
    const regions = within(section).getAllByRole("heading", { level: 3 });
    expect(regions).toHaveLength(14);
    expect(regions[0].textContent).toBe("Auvergne-Rhône-Alpesaucune vente à venir");
    expect(regions.map((region) => region.textContent)).toContain(
      "Nouvelle-Aquitaine3 ventes à venir",
    );
    expect(regions.at(-1)?.textContent).toBe("Outre-meraucune vente à venir");
  });

  it("filtre la liste en direct, par nom sans accent ou par numéro", async () => {
    mocks.load.mockResolvedValue({ status: "ok", catalogue: CATALOGUE });
    render(await Page());
    const section = screen.getByRole("region", { name: "Tous les départements" });
    const search = screen.getByRole("searchbox", { name: "Trouver un département" });

    fireEvent.change(search, { target: { value: "cote d'or" } });
    expect(
      within(section)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Côte-d'Or (21)Aucune vente à venir"]);

    fireEvent.change(search, { target: { value: "33" } });
    expect(
      within(section)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual(["/ventes-encheres-immobilieres/gironde"]);

    fireEvent.change(search, { target: { value: "herault" } });
    expect(within(section).getAllByRole("link")).toHaveLength(1);

    fireEvent.change(search, { target: { value: "atlantide" } });
    expect(within(section).queryAllByRole("link")).toHaveLength(0);
    expect(section.textContent).toContain("Aucun département ne correspond à « atlantide »");
  });

  it("classe la liste par nombre de ventes ou de A à Z (boutons à bascule)", async () => {
    mocks.load.mockResolvedValue({ status: "ok", catalogue: CATALOGUE });
    render(await Page());
    const section = screen.getByRole("region", { name: "Tous les départements" });
    const byCount = within(section).getByRole("button", { name: "Par nombre de ventes" });
    expect(
      within(section).getByRole("button", { name: "Par région" }).getAttribute("aria-pressed"),
    ).toBe("true");

    fireEvent.click(byCount);
    expect(byCount.getAttribute("aria-pressed")).toBe("true");
    const hrefs = within(section)
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    expect(hrefs).toHaveLength(DEPARTMENTS.length);
    expect(hrefs.slice(0, 3)).toEqual([
      "/ventes-encheres-immobilieres/gironde",
      "/ventes-encheres-immobilieres/paris",
      "/ventes-encheres-immobilieres/ain",
    ]);
    expect(within(section).queryAllByRole("heading", { level: 3 })).toHaveLength(0);

    fireEvent.click(within(section).getByRole("button", { name: "De A à Z" }));
    const names = within(section)
      .getAllByRole("link")
      .map((link) => link.textContent?.replace(/ \(.*$/, ""));
    expect(names.slice(0, 3)).toEqual(["Ain", "Aisne", "Allier"]);
  });

  it("renvoie vers la carte de toutes les ventes et vers les tribunaux", async () => {
    mocks.load.mockResolvedValue({ status: "ok", catalogue: CATALOGUE });
    render(await Page());
    expect(
      screen
        .getByRole("link", { name: "Voir toutes les ventes sur la carte" })
        .getAttribute("href"),
    ).toBe("/sales");
    expect(
      screen
        .getByRole("link", { name: "Voir les tribunaux et leur activité" })
        .getAttribute("href"),
    ).toBe("/tribunaux");
  });

  it("reste disponible sans chiffres quand la base est indisponible", async () => {
    mocks.load.mockResolvedValue({ status: "error" });
    render(await Page());
    const section = screen.getByRole("region", { name: "Tous les départements" });
    expect(within(section).getAllByRole("link")).toHaveLength(DEPARTMENTS.length);
    expect(screen.getByRole("status").textContent).toContain("momentanément indisponibles");
    expect(section.textContent).not.toContain("Aucune vente à venir");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Ventes aux enchères immobilières par département",
    );
    // Sans chiffres : ni carte, ni classement, ni tri par nombre de ventes.
    expect(screen.queryByRole("region", { name: "Où se trouvent les ventes" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Les départements les plus actifs" })).toBeNull();
    expect(within(section).queryByRole("button", { name: "Par nombre de ventes" })).toBeNull();
    // La recherche d'un département marche toujours.
    expect(screen.getByRole("searchbox", { name: "Trouver un département" })).toBeTruthy();
  });

  it("émet le fil d'Ariane de la page", async () => {
    mocks.load.mockResolvedValue({ status: "ok", catalogue: CATALOGUE });
    const { container } = render(await Page());
    const data = JSON.parse(
      container.querySelector('script[type="application/ld+json"]')?.textContent ?? "{}",
    );
    expect(data["@type"]).toBe("BreadcrumbList");
    expect(data.itemListElement.at(-1).item).toBe(
      "https://immojudis.com/ventes-encheres-immobilieres",
    );
  });

  it("est indexable avec canonical quand une page de département l'est", async () => {
    mocks.load.mockResolvedValue({ status: "ok", catalogue: CATALOGUE });
    const metadata = await generateMetadata();
    expect(metadata.robots).toBeUndefined();
    expect(metadata.alternates?.canonical).toBe("/ventes-encheres-immobilieres");
    expect(String(metadata.title).length + " - Immojudis".length).toBeLessThanOrEqual(60);
  });

  it("passe en noindex quand aucun département n'atteint le seuil", async () => {
    mocks.load.mockResolvedValue({
      status: "ok",
      catalogue: aggregateDepartments([sale("a", "33"), sale("b", "75")]),
    });
    expect((await generateMetadata()).robots).toEqual({ index: false, follow: true });
  });

  it("reste indexable quand la lecture échoue : une panne ne dit rien des départements", async () => {
    mocks.load.mockResolvedValue({ status: "error" });
    expect((await generateMetadata()).robots).toBeUndefined();
  });
});
