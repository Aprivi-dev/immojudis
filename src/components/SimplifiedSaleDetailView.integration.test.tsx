// @vitest-environment jsdom

import * as React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => auth,
}));

vi.mock("@/lib/client-api", () => ({
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

async function openTab(name: string) {
  fireEvent.click(screen.getByRole("tab", { name }));
  await waitFor(() =>
    expect(screen.getByRole("tab", { name }).getAttribute("aria-selected")).toBe("true"),
  );
}

async function openWorksEditor() {
  await openTab("Travaux");
  await waitFor(() =>
    expect(screen.getByRole("heading", { name: "Travaux et état du bien" })).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Détailler le budget" }));
}

beforeEach(() => {
  auth.user = { id: "account-a" };
  auth.loading = false;
  installLocalStorage();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("integrated scenario workspace", () => {
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
      await openWorksEditor();
      fireEvent.change(screen.getByLabelText("Libellé du poste 1"), {
        target: { value: "Peinture" },
      });
      fireEvent.change(screen.getByLabelText("Prix unitaire du poste 1"), {
        target: { value: "1200" },
      });
      expect(screen.getByText("Détail saisi")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Utiliser ce budget" })).toBeNull();
      expect(screen.queryByText("Votre scénario")).toBeNull();
    },
  );

  it("reserves the works editor for Premium while keeping a clear trial preview", async () => {
    renderDetail("discovery");
    await openTab("Travaux");
    expect(
      screen.getByRole("heading", { name: "Estimez vos travaux avec l’offre Analyse" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Détailler le budget" })).toBeNull();
    expect(screen.queryByLabelText("Libellé du poste 1")).toBeNull();
    expect(
      screen.getByRole("link", { name: "Découvrir l’offre Analyse" }).getAttribute("href"),
    ).toBe("/offres");
  });

  it("does not expose the email draft workflow on the Premium listing", () => {
    renderDetail("analysis");

    expect(screen.queryByRole("button", { name: /Préparer une demande/i })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Message prêt à copier" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Copier le message/i })).toBeNull();
  });

  it("propagates an explicitly applied works total to the hero, financing and the bid ceiling", async () => {
    renderDetail();
    await openWorksEditor();

    fireEvent.change(screen.getByLabelText("Libellé du poste 1"), {
      target: { value: "Peinture" },
    });
    fireEvent.change(screen.getByLabelText("Quantité du poste 1"), {
      target: { value: "2" },
    });
    fireEvent.change(screen.getByLabelText("Unité du poste 1"), {
      target: { value: "m²" },
    });
    fireEvent.change(screen.getByLabelText("Prix unitaire du poste 1"), {
      target: { value: "1100" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Utiliser ce budget" }));

    await waitFor(() => expect(screen.getByText("Votre scénario")).toBeTruthy());
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
      const row = screen.getByText("Votre montant").closest("tr")!;
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
      const row = screen.getByText("Votre montant").closest("tr")!;
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
    await openWorksEditor();
    fireEvent.change(screen.getByLabelText("Libellé du poste 1"), {
      target: { value: "Peinture" },
    });
    fireEvent.change(screen.getByLabelText("Prix unitaire du poste 1"), {
      target: { value: "900" },
    });

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
      expect((screen.getByLabelText("Libellé du poste 1") as HTMLInputElement).value).toBe(
        "Peinture",
      );
      expect((screen.getByLabelText("Prix unitaire du poste 1") as HTMLInputElement).value).toBe(
        "900",
      );
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
    await openWorksEditor();
    fireEvent.change(screen.getByLabelText("Libellé du poste 1"), {
      target: { value: "Compte A" },
    });

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
    await waitFor(() => expect(screen.queryByDisplayValue("Compte A")).toBeNull());
  });
});
