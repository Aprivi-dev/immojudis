// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render as renderElement, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adjudicationDirectoryFixture,
  COURT_CODE_MARKERS,
  TRIBUNAL_MARKERS,
} from "@/test/adjudication-price-directory";

const mocks = vi.hoisted(() => ({ getDirectory: vi.fn() }));

vi.mock("@/lib/adjudication-price-statistics-repository", () => ({
  getAdjudicationPriceStatisticsDirectory: mocks.getDirectory,
}));

import Page, { generateMetadata, revalidate } from "./page";

/** La page est rendue dans l'application, sous son QueryClientProvider (`src/app/providers.tsx`). */
function render(element: ReactElement) {
  return renderElement(
    <QueryClientProvider client={new QueryClient()}>{element}</QueryClientProvider>,
  );
}

/** Intl met des espaces insécables (fines) dans les nombres : on les ramène à des espaces. */
const plain = (text: string | null) => (text ?? "").replace(/[\u00a0\u202f]/g, " ");

const NOT_FOUND = expect.objectContaining({ digest: expect.stringContaining("404") });

function openFlags() {
  vi.stubEnv("PUBLIC_ADJUDICATION_PRICES_ENABLED", "true");
  vi.stubEnv("ADJUDICATION_PRICE_STATISTICS_ENABLED", "true");
}

describe("/prix-encheres-immobilieres", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("SITE_URL", "https://immojudis.com");
    mocks.getDirectory.mockResolvedValue(adjudicationDirectoryFixture());
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  it("est rafraîchie toutes les 5 minutes (littéral exigé par Next.js)", () => {
    expect(revalidate).toBe(300);
  });

  describe("drapeau éteint (défaut)", () => {
    it("répond 404 sans rien lire", async () => {
      await expect(Page()).rejects.toEqual(NOT_FOUND);
      expect(mocks.getDirectory).not.toHaveBeenCalled();
    });

    it("répond 404 quand seule la moitié des interrupteurs est ouverte", async () => {
      vi.stubEnv("PUBLIC_ADJUDICATION_PRICES_ENABLED", "true");
      await expect(Page()).rejects.toEqual(NOT_FOUND);
      vi.unstubAllEnvs();
      vi.stubEnv("ADJUDICATION_PRICE_STATISTICS_ENABLED", "true");
      await expect(Page()).rejects.toEqual(NOT_FOUND);
      expect(mocks.getDirectory).not.toHaveBeenCalled();
    });

    it.each(["TRUE", "1", "yes", " true", ""])(
      "reste fermé avec PUBLIC_ADJUDICATION_PRICES_ENABLED=%j",
      async (value) => {
        vi.stubEnv("PUBLIC_ADJUDICATION_PRICES_ENABLED", value);
        vi.stubEnv("ADJUDICATION_PRICE_STATISTICS_ENABLED", "true");
        await expect(Page()).rejects.toEqual(NOT_FOUND);
      },
    );

    it("est noindex et n'annonce ni titre éditorial ni adresse canonique", async () => {
      const metadata = await generateMetadata();
      expect(metadata.robots).toEqual({ index: false, follow: false });
      expect(metadata.alternates).toBeUndefined();
      expect(metadata.openGraph).toBeUndefined();
      expect(mocks.getDirectory).not.toHaveBeenCalled();
    });
  });

  describe("drapeau ouvert", () => {
    beforeEach(openFlags);

    it("affiche la médiane, la part au-dessus de la mise, la période, la date de calcul et la méthode", async () => {
      render(await Page());
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
        "Prix des adjudications immobilières",
      );
      expect(plain(screen.getByTestId("median-ratio").textContent)).toBe("× 1,30");
      expect(plain(screen.getByTestId("above-rate").textContent)).toBe("70 %");
      const page = plain(document.body.textContent);
      expect(page).toContain("1 octobre 2023 au 30 septembre 2026");
      expect(page).toContain("calcul du 5 octobre 2026, revu le 7 octobre 2026");
      expect(screen.getByRole("heading", { name: "Méthode et limites" })).toBeTruthy();
      expect(screen.getByRole("link", { name: "Voir la méthode" }).getAttribute("href")).toBe(
        "#methode",
      );
      expect(document.getElementById("methode")).not.toBeNull();
    });

    it("masque les types de biens sous le seuil et garde les autres", async () => {
      render(await Page());
      const table = screen.getByRole("table");
      const rows = within(table).getAllByRole("row");
      expect(rows.map((row) => row.textContent)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Appartement"),
          expect.stringContaining("Maison"),
          expect.stringContaining("Parking"),
        ]),
      );
      expect(screen.queryByText("Terrain")).toBeNull();
    });

    it("renvoie vers l'offre Analyse pour le détail par tribunal et les scénarios", async () => {
      render(await Page());
      expect(
        screen.getByRole("link", { name: "Découvrir l’offre Analyse" }).getAttribute("href"),
      ).toBe("/offres");
    });

    it("ne sert que des agrégats : aucun tribunal, aucune donnée individuelle", async () => {
      const { container } = render(await Page());
      const html = container.innerHTML + (document.head.innerHTML ?? "");
      for (const marker of [...TRIBUNAL_MARKERS, ...COURT_CODE_MARKERS, "Région-Marqueur"]) {
        expect(html).not.toContain(marker);
      }
      expect(html).not.toContain("777");
      expect(html).not.toMatch(/source_url|href="https?:\/\//);
    });

    it("est indexable, avec titre, description et adresse canonique", async () => {
      const metadata = await generateMetadata();
      expect(metadata.robots).toEqual({ index: true, follow: true });
      expect(metadata.alternates?.canonical).toBe("/prix-encheres-immobilieres");
      expect(metadata.openGraph).toMatchObject({ url: "/prix-encheres-immobilieres" });
      const title = String(metadata.title);
      expect(title.length + " - Immojudis".length).toBeLessThanOrEqual(60);
      expect(String(metadata.description).length).toBeLessThanOrEqual(160);
    });

    it("n'affiche aucun chiffre et reste noindex quand les statistiques sont indisponibles", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      mocks.getDirectory.mockRejectedValue(new Error("No reviewed national build"));
      render(await Page());
      expect(screen.queryByTestId("median-ratio")).toBeNull();
      expect(screen.getByText(/ne sont pas disponibles/i)).toBeTruthy();
      expect((await generateMetadata()).robots).toEqual({ index: false, follow: false });
    });

    it("n'affiche aucun chiffre quand l'échantillon national est sous le seuil", async () => {
      const directory = adjudicationDirectoryFixture();
      directory.national.sampleSize = 9;
      mocks.getDirectory.mockResolvedValue(directory);
      render(await Page());
      expect(screen.queryByTestId("median-ratio")).toBeNull();
      expect((await generateMetadata()).robots).toEqual({ index: false, follow: false });
    });
  });
});
