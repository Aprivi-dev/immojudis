// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
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
    expect(document.body.textContent).toContain("4 ventes à venir dans le catalogue public");
  });

  it("reste disponible sans chiffres quand la base est indisponible", async () => {
    mocks.load.mockResolvedValue({ status: "error" });
    render(await Page());
    const section = screen.getByRole("region", { name: "Tous les départements" });
    expect(within(section).getAllByRole("link")).toHaveLength(DEPARTMENTS.length);
    expect(screen.getByRole("status").textContent).toContain("momentanément indisponibles");
    expect(section.textContent).not.toContain("Aucune vente à venir");
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
