// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyFavoriteDossier, type FavoriteDossier } from "@/lib/favorite-dossier-shared";
import { AnalysisLead, DossierActions, SaleFollowChanges } from "./SaleAnalysisPanel";

const mocks = vi.hoisted(() => ({
  auth: { user: { id: "user-1" } as { id: string } | null, loading: false },
  fetchDossier: vi.fn(),
  saveDossier: vi.fn(),
  fetchChanges: vi.fn(),
  preferences: vi.fn(),
  updatePreferences: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => mocks.auth }));
vi.mock("@/lib/client-api", () => ({
  fetchFavoriteDossier: mocks.fetchDossier,
  saveFavoriteDossier: mocks.saveDossier,
  fetchSaleChangeEvents: mocks.fetchChanges,
  fetchNotificationPreferences: mocks.preferences,
  updateNotificationPreferences: mocks.updatePreferences,
}));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/FavoriteButton", () => ({
  FavoriteButton: ({ saleId }: { saleId: string }) => <button>Suivre {saleId}</button>,
}));

const SALE_ID = "sale-1";

function wrap(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

function dossier(overrides: Partial<FavoriteDossier> = {}): { dossier: FavoriteDossier } {
  return { dossier: { ...emptyFavoriteDossier(SALE_ID), followed: true, ...overrides } };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AnalysisLead", () => {
  const lead = (startGap: number) =>
    render(
      <AnalysisLead
        label="Enchère plafond (simulation)"
        ceiling={{ kind: "amount", amount: 462_500, note: "", reliability: null, startGap }}
        startLabel="Mise à prix"
        startingPrice={450_000}
        value={555_000}
        hypotheses="Habiter · Équilibré · sans travaux"
        modifyHref="#calculation"
      />,
    );

  it("met le plafond en grand et son écart en pastille verte au-dessus de la mise à prix", () => {
    const { container } = lead(12_500);
    expect(screen.getByText(/^462.500\s€$/)).toBeTruthy();
    expect(screen.getByText(/^\+12.500\s€ par rapport à la mise à prix$/)).toBeTruthy();
    expect(container.textContent).toMatch(/Mise à prix 450.000\s€ · valeur estimée 555.000\s€/);
    expect(screen.getByRole("link", { name: "Modifier les hypothèses" }).getAttribute("href")).toBe(
      "#calculation",
    );
  });

  it("dit l'écart sous la mise à prix sans conseiller de ne pas enchérir", () => {
    const { container } = lead(-8_000);
    expect(screen.getByText(/^8.000\s€ sous la mise à prix, à ces hypothèses$/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/ne pas enchérir/i);
  });
});

describe("DossierActions", () => {
  it("enregistre le statut du dossier et ouvre le dossier de travail", async () => {
    mocks.fetchDossier.mockResolvedValue(dossier({ bidCeilingEur: 150_000 }));
    mocks.saveDossier.mockResolvedValue(dossier({ personalStatus: "reviewing" }));
    mocks.preferences.mockResolvedValue({
      preferences: { saleRemindersEnabled: false },
      saleRemindersAvailable: true,
    });
    const open = vi.fn();
    wrap(<DossierActions saleId={SALE_ID} onOpenWorkspace={open} reportHref="#rapport" />);

    const status = await screen.findByLabelText("Statut de mon dossier");
    expect(screen.getByTestId("panel-saved-ceiling").textContent).toMatch(/150.000/);
    fireEvent.change(status, { target: { value: (status as HTMLSelectElement).options[1].value } });
    await waitFor(() => expect(mocks.saveDossier).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Ouvrir Mon dossier" }));
    expect(open).toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Rapport PDF" }).getAttribute("href")).toBe("#rapport");
    // Les rappels non activés mènent à « Mon dossier », où la case présente le texte de consentement.
    expect((await screen.findByRole("link", { name: "Rappels" })).getAttribute("href")).toBe(
      "#mon-dossier",
    );
  });

  it("propose de suivre la vente avant tout enregistrement", async () => {
    mocks.fetchDossier.mockResolvedValue({
      dossier: { ...emptyFavoriteDossier(SALE_ID), followed: false },
    });
    mocks.preferences.mockResolvedValue({
      preferences: { saleRemindersEnabled: true },
      saleRemindersAvailable: true,
    });
    wrap(<DossierActions saleId={SALE_ID} />);

    expect(await screen.findByRole("button", { name: `Suivre ${SALE_ID}` })).toBeTruthy();
    expect(screen.queryByLabelText("Statut de mon dossier")).toBeNull();
    expect(screen.queryByRole("button", { name: "Ouvrir Mon dossier" })).toBeNull();
    expect(
      (await screen.findByRole("button", { name: "Rappels activés" })).getAttribute("aria-pressed"),
    ).toBe("true");
  });
});

describe("SaleFollowChanges", () => {
  it("liste les changements détectés sur la vente", async () => {
    mocks.fetchChanges.mockResolvedValue({
      events: [
        {
          id: "e1",
          saleId: SALE_ID,
          eventKind: "price_changed",
          summaryLabel: "",
          detectedAt: new Date().toISOString(),
          changeSummary: { previousValue: 120_000, currentValue: 100_000 },
        },
      ],
    });
    wrap(<SaleFollowChanges saleId={SALE_ID} userId="user-1" hiddenTopics={new Set()} />);

    expect(await screen.findByRole("heading", { name: "Changements de cette vente" })).toBeTruthy();
    expect(screen.getByText(/Mise à prix abaissée/)).toBeTruthy();
    expect(mocks.fetchChanges).toHaveBeenCalledWith({
      saleId: SALE_ID,
      includeDismissed: true,
      limit: 50,
    });
  });

  it("le dit quand rien n'a changé", async () => {
    mocks.fetchChanges.mockResolvedValue({ events: [] });
    wrap(<SaleFollowChanges saleId={SALE_ID} userId="user-1" hiddenTopics={new Set()} />);
    expect(await screen.findByText(/Aucun changement détecté ces 30 derniers jours/)).toBeTruthy();
  });
});
