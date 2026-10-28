// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTribunalJudicialActivityDirectory,
  type TribunalJudicialActivityDirectorySale,
} from "@/lib/tribunal-judicial-activity-directory";
import { PUBLIC_TRIBUNAL_ACTIVITY_FAILURE_RETRY_MS } from "@/lib/public-tribunal-activity.server";
import Page, { generateMetadata, revalidate } from "./page";

const mocks = vi.hoisted(() => ({
  fetchDirectory: vi.fn(),
  fetchPlan: vi.fn(),
  useAuth: vi.fn(),
  loadPublicActivity: vi.fn(),
}));

vi.mock("@/lib/public-tribunal-activity.server", () => ({
  loadPublicTribunalActivity: mocks.loadPublicActivity,
  PUBLIC_TRIBUNAL_ACTIVITY_FAILURE_RETRY_MS: 5 * 60_000,
}));

vi.mock("@/lib/tribunal-judicial-activity-directory-client", () => ({
  fetchTribunalJudicialActivityDirectory: mocks.fetchDirectory,
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: mocks.useAuth }));
vi.mock("@/lib/client-api", () => ({ fetchAccessPlan: mocks.fetchPlan }));
vi.mock("@/components/PremiumAdjudicationExplorer", () => ({
  PremiumAdjudicationExplorer: () => <section aria-label="Résultats premium Licitor" />,
}));

const ACTIVITY = {
  code: "bobigny",
  name: "Bobigny",
  searchName: "TJ Bobigny",
  city: "Bobigny",
  department: "93",
  upcomingCount: 107,
  nextSaleDate: "2026-10-13T00:00:00Z",
  medianStartingPriceEur: 40_500,
  pricedCount: 107,
  houseCount: 20,
  apartmentCount: 80,
  otherCount: 7,
};

const AS_OF = new Date("2026-08-20T12:00:00.000Z");
const DIRECTORY = buildTribunalJudicialActivityDirectory({
  courts: [
    { code: "marseille", name: "TJ Marseille", judicialRegion: "Aix-en-Provence" },
    { code: "paris", name: "TJ Paris", judicialRegion: "Paris" },
  ],
  sales: [...courtSales("marseille", 6, 20_000), ...courtSales("paris", 5, 80_000)],
  asOf: AS_OF,
  historyMonths: 36,
});

describe("/tribunaux", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useAuth.mockReturnValue({
      session: { user: { id: "premium-user" } },
      loading: false,
    });
    mocks.fetchPlan.mockResolvedValue({ plan: { hasAnalysisAccess: true } });
    mocks.fetchDirectory.mockResolvedValue(DIRECTORY);
    mocks.loadPublicActivity.mockResolvedValue({ status: "ok", items: [] });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  it("affiche les fourchettes de mise et de délai au membre Analyse", async () => {
    vi.stubEnv("ADJUDICATION_PRICE_STATISTICS_ENABLED", "true");
    await renderPage();

    expect(await screen.findByRole("heading", { name: "TJ Marseille" })).toBeTruthy();
    expect(screen.getByText(/Fourchette centrale 21 250 € – 23 750 €/i)).toBeTruthy();
    expect(screen.getByText(/Fourchette centrale 23 – 28 jours/i)).toBeTruthy();
    expect(screen.getByRole("region", { name: "Résultats premium Licitor" })).toBeTruthy();
    expect(screen.getByText(/Issues définitives et délais de décision non publiés/i)).toBeTruthy();
    expect(mocks.fetchDirectory).toHaveBeenCalledWith(36);
  });

  it("permet au membre Analyse de rechercher un autre tribunal", async () => {
    await renderPage();
    await screen.findByRole("heading", { name: "TJ Marseille" });

    fireEvent.change(screen.getByPlaceholderText("Marseille, Paris, Lyon…"), {
      target: { value: "Paris" },
    });

    expect(await screen.findByRole("heading", { name: "TJ Paris" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "TJ Marseille" })).toBeNull();
  });

  it("affiche un aperçu sans charger l’annuaire pour un visiteur ou la Découverte", async () => {
    mocks.useAuth.mockReturnValue({ session: null, loading: false });

    await renderPage();

    expect(
      await screen.findByRole("region", {
        name: "Activité des annonces et prochaines audiences",
      }),
    ).toBeTruthy();
    expect(mocks.fetchDirectory).not.toHaveBeenCalled();

    cleanup();
    mocks.useAuth.mockReturnValue({
      session: { user: { id: "discovery-user" } },
      loading: false,
    });
    mocks.fetchPlan.mockResolvedValue({ plan: { hasAnalysisAccess: false } });

    await renderPage();

    expect(
      await screen.findByRole("region", {
        name: "Activité des annonces et prochaines audiences",
      }),
    ).toBeTruthy();
    expect(mocks.fetchDirectory).not.toHaveBeenCalled();
  });

  it("montre l’activité publique des tribunaux sans compte, sans résultat d’adjudication", async () => {
    mocks.useAuth.mockReturnValue({ session: null, loading: false });
    mocks.loadPublicActivity.mockResolvedValue({ status: "ok", items: [ACTIVITY] });

    await renderPage();

    const section = screen.getByRole("region", {
      name: "107 ventes judiciaires à venir dans 1 tribunal",
    });
    // Un seul lien par ligne : le nom, vers la page du tribunal (qui renvoie à la recherche filtrée).
    expect(screen.getByRole("link", { name: "Bobigny" }).getAttribute("href")).toBe(
      "/tribunaux/bobigny",
    );
    const row = screen.getByRole("link", { name: "Bobigny" }).closest("tr");
    expect(row?.querySelectorAll("a")).toHaveLength(1);
    expect(row?.textContent).toContain("107");
    expect(screen.queryByRole("link", { name: /Voir dans la recherche/ })).toBeNull();
    expect(
      screen.getByRole("link", { name: "la page des audiences à venir" }).getAttribute("href"),
    ).toBe("/audiences-a-venir");
    expect(section.textContent).toMatch(/40\s500\s€/);
    expect(section.textContent).toContain("13 oct.");
    // Tant que les statistiques d'adjudication sont fermées, la page ne les annonce pas.
    expect(section.textContent).not.toContain("adjudication");
    expect(screen.queryByRole("region", { name: "Résultats premium Licitor" })).toBeNull();
    expect(document.body.textContent).not.toMatch(/adjug|adjudication/i);
    expect(mocks.fetchDirectory).not.toHaveBeenCalled();
  });

  it("annonce les résultats d’adjudication réservés à Analyse une fois les statistiques ouvertes", async () => {
    vi.stubEnv("ADJUDICATION_PRICE_STATISTICS_ENABLED", "true");
    mocks.useAuth.mockReturnValue({ session: null, loading: false });
    mocks.loadPublicActivity.mockResolvedValue({ status: "ok", items: [ACTIVITY] });

    await renderPage();

    expect(
      screen.getByRole("region", { name: "107 ventes judiciaires à venir dans 1 tribunal" })
        .textContent,
    ).toContain("réservés à l’offre Analyse");
    expect(screen.getByRole("region", { name: "Résultats premium Licitor" })).toBeTruthy();
  });

  it("n’affiche pas le baromètre d’adjudication tant que le drapeau est fermé", async () => {
    await renderPage();

    await screen.findByRole("heading", { name: "TJ Marseille" });
    expect(screen.queryByRole("region", { name: "Résultats premium Licitor" })).toBeNull();
  });

  describe("métadonnées", () => {
    it("décrit ce qui est affiché, sans prix d’adjudication, et s’indexe quand des tribunaux sont listés", async () => {
      mocks.loadPublicActivity.mockResolvedValue({ status: "ok", items: [ACTIVITY] });

      const metadata = await generateMetadata();

      expect(metadata.title).toBe("Ventes judiciaires à venir par tribunal");
      expect(String(metadata.description)).not.toMatch(/adjudication/i);
      expect(metadata.alternates?.canonical).toBe("/tribunaux");
      expect(metadata.robots).toEqual({ index: true, follow: true });
    });

    it("annonce les prix d’adjudication avec leur réserve de couverture quand le drapeau est ouvert", async () => {
      vi.stubEnv("ADJUDICATION_PRICE_STATISTICS_ENABLED", "true");
      mocks.loadPublicActivity.mockResolvedValue({ status: "ok", items: [ACTIVITY] });

      const { description } = await generateMetadata();

      expect(String(description)).toMatch(
        /prix d’adjudication et résultats avec l’offre Analyse, pour les tribunaux à l’historique suffisant\.$/,
      );
    });

    it("n’indexe pas la page quand la lecture réussit et que la liste des tribunaux est vide", async () => {
      mocks.loadPublicActivity.mockResolvedValue({ status: "ok", items: [] });

      const metadata = await generateMetadata();

      expect(metadata.robots).toEqual({ index: false, follow: true });
    });

    it("ne pose pas noindex quand la lecture des tribunaux a échoué", async () => {
      mocks.loadPublicActivity.mockResolvedValue({ status: "error" });

      const metadata = await generateMetadata();

      expect(metadata.robots).toEqual({ index: true, follow: true });
    });

    it("rafraîchit la page toutes les 5 minutes, comme la mémoire d’un échec de lecture", () => {
      expect(revalidate).toBe(PUBLIC_TRIBUNAL_ACTIVITY_FAILURE_RETRY_MS / 1000);
    });

    it("mentionne les prix d’adjudication seulement une fois les statistiques ouvertes", async () => {
      vi.stubEnv("ADJUDICATION_PRICE_STATISTICS_ENABLED", "true");
      mocks.loadPublicActivity.mockResolvedValue({ status: "ok", items: [ACTIVITY] });

      expect(String((await generateMetadata()).description)).toMatch(/adjudication/i);
    });
  });

  it("affiche le baromètre Analyse seul quand la lecture des tribunaux a échoué", async () => {
    mocks.loadPublicActivity.mockResolvedValue({ status: "error" });

    await renderPage();

    expect(await screen.findByRole("heading", { name: "TJ Marseille" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: /ventes judiciaires à venir dans/ })).toBeNull();
  });

  it("remplace une erreur interne par un message stable pour le membre Analyse", async () => {
    mocks.fetchDirectory.mockRejectedValue(
      new Error("relation billing_secrets does not exist for tenant 8842"),
    );

    await renderPage();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Statistiques temporairement indisponibles");
    expect(alert.textContent).not.toContain("billing_secrets");
  });

  it("recalcule la période lorsque le membre Analyse choisit 12 mois", async () => {
    await renderPage();
    await screen.findByRole("heading", { name: "TJ Marseille" });

    fireEvent.click(screen.getByRole("button", { name: "12 mois" }));

    await waitFor(() => expect(mocks.fetchDirectory).toHaveBeenCalledWith(12));
  });
});

async function renderPage() {
  const page = await Page();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(<QueryClientProvider client={queryClient}>{page}</QueryClientProvider>);
}

function courtSales(
  tribunalCode: string,
  count: number,
  basePrice: number,
): TribunalJudicialActivityDirectorySale[] {
  return Array.from({ length: count }, (_, index) => {
    const saleDate = new Date(AS_OF.getTime() + (20 + index * 5) * 24 * 60 * 60 * 1_000);
    return {
      tribunalCode,
      id: `${tribunalCode}-${index}`,
      saleDate: saleDate.toISOString(),
      status: "upcoming",
      startingPriceEur: basePrice + index * 1_000,
      propertyType: "apartment",
      visitDates: ["visite annoncée"],
      firstSeenAt: new Date(
        saleDate.getTime() - (20 + index * 2) * 24 * 60 * 60 * 1_000,
      ).toISOString(),
    };
  });
}
