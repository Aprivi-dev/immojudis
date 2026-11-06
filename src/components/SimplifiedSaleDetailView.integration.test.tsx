// @vitest-environment jsdom

import * as React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchInvestorProfile } from "@/lib/client-api";
import { EXAMPLE_SALE_RECORDS } from "@/lib/example-sale";
import { buildCeilingHypotheses } from "@/lib/bid-ceiling-defaults";
import { computeAcquisitionCosts } from "@/lib/profitability";
import { ceilingStorageKey } from "@/components/ceiling/use-ceiling-choices";
import { AnalysisSaleDetailView, FreeSaleDetailView } from "./SimplifiedSaleDetailView";
import type { AuctionSale } from "@/lib/types";

const auth = vi.hoisted(() => ({
  user: { id: "account-a" } as { id: string } | null,
  loading: false,
}));

// Rendu de test : aucune section n'approche de l'écran ; le sommaire monte les blocs de la section suivie.
class NeverIntersectingObserver {
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds = [];
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
vi.stubGlobal("IntersectionObserver", NeverIntersectingObserver);

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => auth,
}));

vi.mock("@/lib/client-api", () => ({
  fetchInvestorProfile: vi.fn(),
  fetchPrecomputedMarketEstimate: vi.fn(),
  fetchSaleAiReviewProjections: vi.fn(),
  fetchSaleFactReliabilities: vi.fn(),
  fetchSaleUrbanismeCadastre: vi.fn(),
}));

vi.mock("@/components/FavoriteButton", () => ({
  FavoriteButton: () => <button type="button">Suivre cette vente</button>,
}));
vi.mock("@/components/MapboxPreviewButton", () => ({
  MapboxPreviewButton: ({ label }: { label: string }) => <button type="button">{label}</button>,
}));
vi.mock("@/components/MapThumbnail", () => ({ MapThumbnail: () => <div>Carte</div> }));
vi.mock("./sale-detail/CadastralNeighborhoodMap", () => ({
  CadastralNeighborhoodMap: () => <div>Plan cadastral</div>,
}));
vi.mock("@/components/SaleVisual", () => ({ SaleVisual: () => <div>Visuel indisponible</div> }));
vi.mock("@/components/BillingActions", () => ({
  BillingActions: () => <button type="button">Découvrir l’offre Analyse</button>,
}));
vi.mock("@/components/DocumentsList", () => ({ DocumentsList: () => <p>Pièces du dossier</p> }));
vi.mock("@/components/LawyerReferralButton", () => ({
  LawyerReferralButton: () => <button type="button">Contacter un avocat</button>,
}));
vi.mock("@/components/ProfessionalPilotLauncher", () => ({
  ProfessionalPilotLauncher: () => <div>Préparation professionnelle</div>,
}));
vi.mock("@/components/SaleProcedurePanel", () => ({
  SaleProcedureBadge: () => <span>Vente judiciaire</span>,
  SaleProcedurePanel: () => <div>Conditions de vente</div>,
}));
vi.mock("@/components/UrbanismeCadastrePanel", () => ({
  UrbanismeCadastrePanel: () => <div>Urbanisme</div>,
}));

vi.mock("@/components/OutcomeForecast", () => ({
  OutcomeForecast: () => <div>Prévision de l’audience</div>,
}));
vi.mock("@/components/PropertyReportActions", () => ({
  PropertyReportActions: () => <button type="button">Export PDF</button>,
}));
vi.mock("@/components/PhotoCarouselDialog", () => ({
  PhotoCarouselDialog: ({ onClose }: { onClose?: () => void }) => (
    <div role="dialog" aria-label="Galerie photos">
      <button type="button" onClick={onClose}>
        Fermer les photos
      </button>
    </div>
  ),
}));

vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
    const LazyComponent = React.lazy(async () => ({ default: await loader() }));
    return function DynamicComponent(props: Record<string, unknown>) {
      return (
        <React.Suspense fallback={<p>Chargement du composant…</p>}>
          <LazyComponent {...props} />
        </React.Suspense>
      );
    };
  },
}));

const sale = EXAMPLE_SALE_RECORDS.bordeaux.sale;
const marketEstimate = EXAMPLE_SALE_RECORDS.bordeaux.marketEstimate;

function installLocalStorage() {
  const values = new Map<string, string>();
  const storage: Storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
}

function renderDetail(
  access: "analysis" | "discovery" = "analysis",
  detailSale: AuctionSale = sale,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const DetailView = access === "analysis" ? AnalysisSaleDetailView : FreeSaleDetailView;
  const view = render(
    <QueryClientProvider client={client}>
      <DetailView sale={detailSale} marketEstimateOverride={marketEstimate} publicDemo />
    </QueryClientProvider>,
  );
  return {
    ...view,
    rerenderDetail: () =>
      view.rerender(
        <QueryClientProvider client={client}>
          <DetailView sale={detailSale} marketEstimateOverride={marketEstimate} publicDemo />
        </QueryClientProvider>,
      ),
  };
}

/** Les anciens onglets et la section de la fiche sur une seule page qui reprend leur contenu. */
const SECTION_FOR_TAB: Record<string, string> = {
  Aperçu: "Le bien",
  "Prix et plafond": "Prix et plafond",
  Travaux: "Travaux et financement",
  Financement: "Travaux et financement",
};

/** Suit le lien du sommaire vers la section qui reprend l'ancien onglet. */
async function openTab(name: string) {
  const sommaire = screen.getByRole("navigation", { name: "Sommaire de la fiche" });
  const link = within(sommaire).getByRole("link", { name: SECTION_FOR_TAB[name] ?? name });
  fireEvent.click(link);
  await waitFor(() => expect(link.getAttribute("aria-current")).toBe("true"));
}

// Ouvre « Détail de vos travaux » (l'unique détail de l'onglet Travaux) et y saisit un poste.
async function addWorksPoste(poste: { kind: string; quantity: string; unitCost: string }) {
  await openTab("Travaux");
  // Le bloc des travaux se charge à la demande quand la section est suivie depuis le sommaire.
  await screen.findByRole("heading", { name: "Travaux et état du bien" }, { timeout: 5_000 });
  fireEvent.click(screen.getByRole("button", { name: "Détailler les travaux" }));
  fireEvent.click(screen.getByRole("button", { name: "Ajouter un poste" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Type, poste 1" }), {
    target: { value: poste.kind },
  });
  fireEvent.change(screen.getByRole("textbox", { name: /^Quantité, poste 1/ }), {
    target: { value: poste.quantity },
  });
  fireEvent.change(screen.getByRole("textbox", { name: /^Coût unitaire, poste 1/ }), {
    target: { value: poste.unitCost },
  });
}

beforeEach(() => {
  auth.user = { id: "account-a" };
  auth.loading = false;
  installLocalStorage();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.mocked(fetchInvestorProfile).mockResolvedValue({ profile: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// La fiche sur une seule page rend ses six sections à chaque saisie : la suite complète, en parallèle,
// dépasse parfois les 5 s par défaut sur les scénarios qui saisissent travaux, financement et loyer.
describe("integrated scenario workspace", { timeout: 15_000 }, () => {
  it.each(["notary"] as const)(
    "keeps works drafts editable without advertising an unavailable shared scenario in %s",
    async (mode) => {
      renderDetail(
        "analysis",
        mode === "notary"
          ? {
              ...sale,
              sale_venue_type: "notary",
              sale_legal_framework: "voluntary_notarial",
              sale_procedure: null,
              source_blocks: { ...sale.source_blocks, sale_procedure: null },
            }
          : sale,
      );
      await addWorksPoste({ kind: "peinture", quantity: "1", unitCost: "1200" });
      expect(
        screen.getByRole("status", { name: "Total de vos postes" }).textContent?.replace(/\s/g, ""),
      ).toBe("1200€");
      expect(screen.queryByText("Votre scénario")).toBeNull();
    },
  );

  it("reserves the works editor for Premium while keeping a clear trial preview", async () => {
    renderDetail("discovery");
    await openTab("Travaux");
    expect(
      screen.getByRole("heading", { name: "Estimez vos travaux avec l’offre Analyse" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Détailler les travaux" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Type, poste 1" })).toBeNull();
    expect(
      within(document.getElementById("travaux-financement")!)
        .getByRole("link", { name: "Découvrir l’offre Analyse" })
        .getAttribute("href"),
    ).toBe("/offres");
  });

  it("does not expose the email draft workflow on the Premium listing", () => {
    renderDetail("analysis");

    expect(screen.queryByRole("button", { name: /Préparer une demande/i })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Message prêt à copier" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Copier le message/i })).toBeNull();
  });

  it("propagates the works total of « Détail de vos travaux » to financing and the bid ceiling", async () => {
    renderDetail();
    await addWorksPoste({ kind: "peinture", quantity: "2", unitCost: "1100" });

    const expectedProjectCost = computeAcquisitionCosts({
      price: sale.starting_price_eur!,
      works: 2_200,
      ...buildCeilingHypotheses(sale, null).fees,
    }).totalCost;

    await openTab("Financement");
    await waitFor(() => {
      const projectPrice = screen.getByLabelText(/Prix du projet/) as HTMLInputElement;
      expect(Number(projectPrice.value)).toBeCloseTo(expectedProjectCost, 1);
      expect(projectPrice.disabled).toBe(true);
      expect(screen.getByText("Coût complet retenu")).toBeTruthy();
    });

    await openTab("Prix et plafond");
    await waitFor(() => {
      // « Votre montant » est aussi une pilule des hypothèses : la ligne du tableau des travaux.
      const row = screen
        .getAllByText("Votre montant")
        .map((label) => label.closest("tr"))
        .find((line) => line != null)!;
      expect(row.getAttribute("aria-current")).toBe("true");
      expect(row.textContent?.replace(/\s/g, "")).toContain("2200€");
      expect(screen.getByText("Travaux (votre montant)")).toBeTruthy();
    });
  });

  it("feeds the budget travaux from « Détail de vos travaux », keeps it in the browser and restores it", async () => {
    const view = renderDetail();
    await openTab("Travaux");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Travaux et état du bien" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Détailler les travaux" }));
    fireEvent.click(screen.getByRole("button", { name: "Ajouter un poste" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Type, poste 1" }), {
      target: { value: "toiture" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /^Quantité, poste 1/ }), {
      target: { value: "2" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /^Coût unitaire, poste 1/ }), {
      target: { value: "4100" },
    });

    // The total of the postes is the budget travaux of the bid ceiling.
    await openTab("Prix et plafond");
    await waitFor(() => {
      // « Votre montant » est aussi une pilule des hypothèses : la ligne du tableau des travaux.
      const row = screen
        .getAllByText("Votre montant")
        .map((label) => label.closest("tr"))
        .find((line) => line != null)!;
      expect(row.getAttribute("aria-current")).toBe("true");
      expect(row.textContent?.replace(/\s/g, "")).toContain("8200€");
    });

    // Saved with the calculator's other hypotheses: the postes and the budget they produced.
    const stored = JSON.parse(
      window.localStorage.getItem(ceilingStorageKey("account-a", sale.id)) ?? "null",
    );
    expect(stored.works.amount).toBe(8_200);
    expect(stored.worksBreakdown).toHaveLength(1);
    expect(stored.worksBreakdown[0]).toMatchObject({
      kind: "toiture",
      quantity: "2",
      unitCost: "4100",
    });

    // A reload restores the panel, open, with the same postes.
    view.unmount();
    renderDetail();
    await openTab("Travaux");
    await waitFor(() =>
      expect(screen.getByRole("group", { name: "Détail de vos travaux" })).toBeTruthy(),
    );
    expect(
      (screen.getByRole("textbox", { name: /^Coût unitaire, poste 1/ }) as HTMLInputElement).value,
    ).toBe("4100");
    expect(
      screen.getByRole("status", { name: "Total de vos postes" }).textContent?.replace(/\s/g, ""),
    ).toBe("8200€");
  });

  it("does not offer « Détailler les travaux » without the Analyse offer", async () => {
    renderDetail("discovery");
    await openTab("Travaux");

    expect(screen.queryByRole("button", { name: "Détailler les travaux" })).toBeNull();
  });

  it("restores works, financing and rental drafts after switching announcement tabs", async () => {
    renderDetail();
    await addWorksPoste({ kind: "peinture", quantity: "1", unitCost: "900" });

    await openTab("Financement");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Simulateur de financement" })).toBeTruthy(),
    );
    fireEvent.change(screen.getByLabelText(/Apport personnel/), {
      target: { value: "60000" },
    });
    fireEvent.change(screen.getByLabelText(/Loyer mensuel hors charges/), {
      target: { value: "1200" },
    });
    fireEvent.change(screen.getByLabelText(/Vacance locative/), {
      target: { value: "5" },
    });

    await openTab("Aperçu");
    await openTab("Travaux");
    await waitFor(() => {
      expect(
        (screen.getByRole("combobox", { name: /^Type, poste 1/ }) as HTMLSelectElement).value,
      ).toBe("peinture");
      expect(
        (screen.getByRole("textbox", { name: /^Coût unitaire, poste 1/ }) as HTMLInputElement)
          .value,
      ).toBe("900");
    });

    await openTab("Financement");
    await waitFor(() => {
      expect((screen.getByLabelText(/Apport personnel/) as HTMLInputElement).value).toBe("60000");
      expect((screen.getByLabelText(/Loyer mensuel hors charges/) as HTMLInputElement).value).toBe(
        "1200",
      );
      expect((screen.getByLabelText(/Vacance locative/) as HTMLInputElement).value).toBe("5");
    });
  });

  it("resets every scenario draft when the authenticated account changes", async () => {
    const view = renderDetail();
    await addWorksPoste({ kind: "peinture", quantity: "1", unitCost: "4321" });

    await openTab("Financement");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Simulateur de financement" })).toBeTruthy(),
    );
    fireEvent.change(screen.getByLabelText(/Apport personnel/), {
      target: { value: "60000" },
    });
    fireEvent.change(screen.getByLabelText(/Loyer mensuel hors charges/), {
      target: { value: "1200" },
    });
    fireEvent.change(screen.getByLabelText(/Vacance locative/), {
      target: { value: "5" },
    });

    auth.user = { id: "account-b" };
    view.rerenderDetail();
    // Nouveau compte : la fiche est remontée ; on revient à la section du financement.
    await openTab("Financement");

    await waitFor(() => {
      expect((screen.getByLabelText(/Apport personnel/) as HTMLInputElement).value).not.toBe(
        "60000",
      );
      expect((screen.getByLabelText(/Loyer mensuel hors charges/) as HTMLInputElement).value).toBe(
        "",
      );
      expect((screen.getByLabelText(/Vacance locative/) as HTMLInputElement).value).toBe("");
    });

    await openTab("Travaux");
    await waitFor(() => expect(screen.queryByDisplayValue("4321")).toBeNull());
  });

  describe("profil d'investisseur du compte", () => {
    const profile = {
      downPaymentEur: 45_000,
      targetMarginPct: null,
      worksPerM2Eur: null,
      strategy: null,
    };

    it("préremplit l'apport du simulateur même si le profil arrive après l'ouverture de l'onglet", async () => {
      let resolveProfile!: (value: { profile: typeof profile }) => void;
      vi.mocked(fetchInvestorProfile).mockReturnValue(
        new Promise((resolve) => {
          resolveProfile = resolve;
        }),
      );
      // Module déjà chargé : sans la correction, le simulateur se monterait avant le profil.
      await import("@/components/sale-detail/FinancingSimulator");
      renderDetail();

      await openTab("Financement");
      await new Promise((resolve) => setTimeout(resolve, 800));
      // Le profil n'est pas encore là : le simulateur n'est pas monté (il ne lit son brouillon
      // de départ qu'au montage).
      expect(screen.queryByLabelText(/Apport personnel/)).toBeNull();

      resolveProfile({ profile });
      await waitFor(() =>
        expect((screen.getByLabelText(/Apport personnel/) as HTMLInputElement).value).toBe("45000"),
      );
    });

    const worksProfile = { ...profile, downPaymentEur: null, worksPerM2Eur: 1_000 };
    const studio: AuctionSale = {
      ...sale,
      title: "Studio à Bordeaux",
      property_type: "apartment",
      rooms_count: 1,
      app_surface_m2: null,
      habitable_surface_m2: null,
      carrez_surface_m2: null,
    };

    it("chiffre les travaux au m² du profil sur la surface publiée de la vente", async () => {
      vi.mocked(fetchInvestorProfile).mockResolvedValue({ profile: worksProfile });
      renderDetail("analysis", { ...studio, app_surface_m2: 30 });
      await openTab("Prix et plafond");
      await waitFor(() => {
        const row = screen.getByText("Travaux (votre montant)").parentElement!.parentElement!;
        expect(row.textContent?.replace(/\s/g, "")).toContain("30000€");
      });
    });

    it("ne chiffre jamais les travaux du profil sur la surface estimée d'un studio sans surface publiée", async () => {
      vi.mocked(fetchInvestorProfile).mockResolvedValue({ profile: worksProfile });
      renderDetail("analysis", studio);
      await openTab("Prix et plafond");
      await waitFor(() => expect(fetchInvestorProfile).toHaveBeenCalled());
      await waitFor(() => expect(screen.getByText("Aucun budget travaux retenu.")).toBeTruthy());
      // Laisse au profil le temps d'être appliqué : aucun montant de travaux ne doit apparaître.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(screen.queryByText("Travaux (votre montant)")).toBeNull();
      expect(screen.getByText("Aucun budget travaux retenu.")).toBeTruthy();
    });
  });
});
