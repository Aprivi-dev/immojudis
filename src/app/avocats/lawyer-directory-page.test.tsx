// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LawyerDirectoryProfile, LawyerDirectoryResponse } from "@/lib/lawyer-directory";

const mocks = vi.hoisted(() => ({
  fetchLawyerDirectory: vi.fn(),
  query: "bar=Bordeaux",
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(mocks.query),
}));

vi.mock("@/lib/client-api", () => ({ fetchLawyerDirectory: mocks.fetchLawyerDirectory }));
vi.mock("@/components/LawyerReferralButton", () => ({ LawyerReferralButton: () => null }));

import { LawyerDirectoryPage } from "./lawyer-directory-page";

function profile(overrides: Partial<LawyerDirectoryProfile>): LawyerDirectoryProfile {
  return {
    id: "lawyer-1",
    displayName: "Maître Dupont",
    firmName: null,
    email: null,
    phone: null,
    websiteUrl: null,
    barAssociation: "Bordeaux",
    barNumber: null,
    city: "Bordeaux",
    department: "33",
    address: null,
    profileSummary: null,
    practiceTags: [],
    acceptsRemoteContact: false,
    coverageLabels: [],
    matchingLabel: null,
    isSponsored: false,
    placement: null,
    source: "immojudis",
    oathDate: null,
    languages: [],
    ...overrides,
  };
}

function renderDirectory(lawyers: LawyerDirectoryProfile[], query = "bar=Bordeaux") {
  mocks.query = query;
  const response: LawyerDirectoryResponse = {
    lawyers,
    sectorLabel: "Bordeaux",
    barAssociation: "Bordeaux",
    isDemo: false,
    officialSource: null,
  };
  mocks.fetchLawyerDirectory.mockResolvedValue(response);
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <LawyerDirectoryPage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  mocks.fetchLawyerDirectory.mockReset();
});

describe("annuaire des avocats", () => {
  it("ne laisse pas entendre de spécialisation dans les titres", async () => {
    renderDirectory([profile({ id: "a" })]);
    expect(await screen.findByRole("heading", { name: "Avocats de l'annuaire" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Avocats inscrits au barreau",
    );
    expect(document.body.textContent).not.toMatch(/Spécialistes en droit immobilier/i);
  });

  it("affiche « Publicité · Sponsorisé » sur les profils sponsorisés seulement", async () => {
    renderDirectory([
      profile({
        id: "a",
        displayName: "Maître Sponsorisé",
        isSponsored: true,
        placement: "active",
      }),
      profile({ id: "b", displayName: "Maître Standard" }),
    ]);
    const sponsored = (await screen.findByText("Maître Sponsorisé")).closest("article");
    const standard = screen.getByText("Maître Standard").closest("article");
    expect(sponsored).not.toBeNull();
    expect(standard).not.toBeNull();
    expect(within(sponsored as HTMLElement).getByText("Publicité · Sponsorisé")).toBeTruthy();
    expect(within(standard as HTMLElement).queryByText(/Sponsorisé/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/partenaire/i);
  });

  it("signale une mise en avant encore en essai comme telle, sans la dire payée", async () => {
    renderDirectory([
      profile({ id: "t", displayName: "Maître Essai", isSponsored: true, placement: "trial" }),
    ]);
    const trial = (await screen.findByText("Maître Essai")).closest("article") as HTMLElement;
    expect(
      within(trial).getByText("Publicité · Sponsorisé (période d’essai gratuite)"),
    ).toBeTruthy();
    expect(within(trial).queryByText("Publicité · Sponsorisé")).toBeNull();
    expect(screen.getByText("Mise en avant (essai ou payante)")).toBeTruthy();
    expect(document.body.textContent).not.toContain("rémunèrent Immojudis");
  });

  it("décrit le classement réel des avocats", async () => {
    renderDirectory([profile({ id: "a" })]);
    const heading = await screen.findByRole("heading", {
      name: "Comment sont classés les avocats ?",
    });
    const text = heading.parentElement?.textContent ?? "";
    expect(text).toContain("barreau");
    expect(text).toContain("niveau de priorité attribué par Immojudis");
    expect(text).toContain("ordre alphabétique");
    expect(text).toContain("annuaire officiel du CNB");
  });

  it("n'affiche pas plus de trois domaines d'intervention par avocat", async () => {
    renderDirectory([
      profile({ id: "a", practiceTags: ["un", "deux", "trois", "quatre", "cinq"] }),
    ]);
    const tags = await screen.findByRole("list", { name: "Domaines d'intervention" });
    expect(
      within(tags)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Un", "Deux", "Trois"]);
  });

  describe("ventes à venir de l'avocat poursuivant", () => {
    const upcoming = {
      total: 7,
      sales: [
        {
          id: "0b1f7f3e-9a2c-4c55-8d5e-111111111111",
          city: "Mérignac",
          propertyType: "apartment",
          saleDate: "2026-12-01T09:00:00Z",
          startingPriceEur: 85_000,
          tribunalName: "Tribunal judiciaire de Bordeaux",
        },
        {
          id: "0b1f7f3e-9a2c-4c55-8d5e-222222222222",
          city: null,
          propertyType: null,
          saleDate: null,
          startingPriceEur: 0,
          tribunalName: null,
        },
      ],
    };

    it("liste ses ventes avec des faits publics seulement, chacune liée à sa fiche", async () => {
      renderDirectory([
        profile({
          id: "a",
          displayName: "Maître Claire Durand",
          upcomingProsecutedSales: upcoming,
        }),
        profile({ id: "b", displayName: "Maître Sans Vente" }),
      ]);
      const card = (await screen.findByText("Maître Claire Durand")).closest("article");
      const section = within(card as HTMLElement).getByRole("region", {
        name: "Ventes à venir en tant qu'avocat poursuivant",
      });

      const links = within(section).getAllByRole("link");
      expect(links.map((link) => link.getAttribute("href"))).toEqual([
        "/sales/0b1f7f3e-9a2c-4c55-8d5e-111111111111",
        "/sales/0b1f7f3e-9a2c-4c55-8d5e-222222222222",
      ]);
      expect(links[0].textContent).toContain("Appartement à Mérignac");
      expect(links[0].textContent).toContain("Tribunal judiciaire de Bordeaux");
      expect(links[0].textContent).toMatch(/Mise à prix 85\s000\s€/);
      // A sale with nothing public to say still shows only what it has, never a 0 € price.
      expect(links[1].textContent).not.toMatch(/Mise à prix/);
      expect(within(section).getByText("5 autres ventes à venir non affichées.")).toBeTruthy();
      expect(section.textContent).toContain("Rapprochement automatique");
      expect(section.textContent).toContain("n'est pas une recommandation");
      const other = screen.getByText("Maître Sans Vente").closest("article") as HTMLElement;
      expect(within(other).queryByText(/avocat poursuivant/)).toBeNull();
    });

    it("garde la mention « Publicité · Sponsorisé » d'un profil mis en avant, sans rien y ajouter", async () => {
      renderDirectory([
        profile({
          id: "a",
          displayName: "Maître Sponsorisé",
          isSponsored: true,
          placement: "active",
          upcomingProsecutedSales: upcoming,
        }),
      ]);
      const card = (await screen.findByText("Maître Sponsorisé")).closest("article") as HTMLElement;

      expect(within(card).getByText("Publicité · Sponsorisé")).toBeTruthy();
      expect(within(card).getAllByText(/Publicité · Sponsorisé/)).toHaveLength(1);
      expect(
        within(card).getByRole("region", {
          name: "Ventes à venir en tant qu'avocat poursuivant",
        }),
      ).toBeTruthy();
    });

    it("n'affiche aucune section sans vente rapprochée", async () => {
      renderDirectory([
        profile({ id: "a", upcomingProsecutedSales: { total: 0, sales: [] } }),
        profile({ id: "b", displayName: "Maître Autre" }),
      ]);
      await screen.findByText("Maître Autre");

      expect(screen.queryByText(/Ventes à venir en tant qu'avocat poursuivant/)).toBeNull();
    });
  });

  describe("filtres lus dans l'adresse, côté navigateur", () => {
    it("remplit le formulaire et interroge l'annuaire avec les filtres de l'adresse", async () => {
      renderDirectory([profile({ id: "a" })], "bar=Pau&saleId=abc&city=Tarbes&department=64&x=1");

      await screen.findByRole("heading", { name: "Avocats de l'annuaire" });

      expect(mocks.fetchLawyerDirectory).toHaveBeenCalledTimes(1);
      expect(mocks.fetchLawyerDirectory).toHaveBeenCalledWith({
        bar: "Pau",
        saleId: "abc",
        city: "Tarbes",
        department: "64",
      });
      expect(
        (screen.getByPlaceholderText("Bordeaux, Paris, Lyon…") as HTMLInputElement).value,
      ).toBe("Pau");
      expect(document.querySelector('input[name="saleId"]')?.getAttribute("value")).toBe("abc");
      expect(screen.getByRole("link", { name: "Retour à l'annonce" }).getAttribute("href")).toBe(
        "/sales/abc",
      );
    });

    it("garde la dernière valeur d'un paramètre répété, comme la page serveur d'avant", async () => {
      renderDirectory([profile({ id: "a" })], "saleId=x&saleId=abc&bar=Lyon&bar=Paris");

      await screen.findByRole("heading", { name: "Avocats de l'annuaire" });

      expect(mocks.fetchLawyerDirectory).toHaveBeenCalledWith({ saleId: "abc", bar: "Paris" });
    });

    it("sans filtre : annuaire non filtré, lien de retour vers les ventes, pas de vente cachée", async () => {
      renderDirectory([profile({ id: "a" })], "");

      await screen.findByRole("heading", { name: "Avocats de l'annuaire" });

      expect(mocks.fetchLawyerDirectory).toHaveBeenCalledWith({});
      expect(screen.getByRole("link", { name: "Retour aux ventes" }).getAttribute("href")).toBe(
        "/sales",
      );
      expect(document.querySelector('input[name="saleId"]')).toBeNull();
    });
  });
});
