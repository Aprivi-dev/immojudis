// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyFavoriteDossier, type FavoriteDossier } from "@/lib/favorite-dossier-shared";
import { PriceScale, priceScaleBounds } from "./PriceScale";
import { ceilingStartGapLabel } from "./PriceSummaryCard";
import { SaveCeilingButton } from "./SaveCeilingButton";

const mocks = vi.hoisted(() => ({
  auth: { user: { id: "user-1" } as { id: string } | null, loading: false },
  fetchDossier: vi.fn(),
  saveDossier: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => mocks.auth }));
vi.mock("@/lib/client-api", () => ({
  fetchFavoriteDossier: mocks.fetchDossier,
  saveFavoriteDossier: mocks.saveDossier,
}));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: mocks.toastError } }));
vi.mock("@/components/FavoriteButton", () => ({
  FavoriteButton: ({ saleId }: { saleId: string }) => <button>Suivre {saleId}</button>,
}));

const SALE_ID = "sale-1";

function dossier(overrides: Partial<FavoriteDossier> = {}): { dossier: FavoriteDossier } {
  return { dossier: { ...emptyFavoriteDossier(SALE_ID), followed: true, ...overrides } };
}

function renderButton(ceiling: number | null = 162_500) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SaveCeilingButton saleId={SALE_ID} ceiling={ceiling} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SaveCeilingButton", () => {
  it("enregistre le plafond calculé dans « Mon dossier » et le dit", async () => {
    mocks.fetchDossier.mockResolvedValue(dossier());
    mocks.saveDossier.mockResolvedValue(
      dossier({ bidCeilingEur: 162_500, bidCeilingSavedAt: "2026-11-06T10:00:00.000Z" }),
    );
    renderButton();

    expect(await screen.findByText("Aucun plafond enregistré pour cette vente.")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Enregistrer ce plafond dans mon dossier" }),
    );

    await waitFor(() =>
      expect(mocks.saveDossier).toHaveBeenCalledWith({
        data: { saleId: SALE_ID, bidCeilingEur: 162_500 },
      }),
    );
    expect((await screen.findByRole("status")).textContent).toMatch(
      /162.500\s€ enregistré dans votre dossier/,
    );
  });

  it("propose d'abord de suivre la vente, sans quoi rien n'est conservé", async () => {
    mocks.fetchDossier.mockResolvedValue({
      dossier: { ...emptyFavoriteDossier(SALE_ID), followed: false },
    });
    renderButton();

    expect(await screen.findByRole("button", { name: `Suivre ${SALE_ID}` })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Enregistrer ce plafond/ })).toBeNull();
  });

  it("n'enregistre rien sans plafond calculé", async () => {
    mocks.fetchDossier.mockResolvedValue(dossier({ bidCeilingEur: 150_000 }));
    renderButton(null);

    expect((await screen.findByText(/Plafond enregistré :/)).textContent).toMatch(/150.000/);
    const button = screen.getByRole("button", { name: "Enregistrer ce plafond dans mon dossier" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button);
    expect(mocks.saveDossier).not.toHaveBeenCalled();
  });
});

describe("PriceScale", () => {
  it("place les montants sur une échelle commune, avec la fourchette de marché", () => {
    render(
      <PriceScale
        startingPrice={450_000}
        startLabel="Mise à prix"
        ceiling={462_500}
        value={555_000}
        range={{ low: 520_000, high: 590_000 }}
      />,
    );
    const scale = screen.getByRole("img");
    expect(scale.getAttribute("aria-label")).toMatch(
      /Mise à prix 450.000\s€, enchère plafond 462.500\s€, valeur estimée 555.000\s€, fourchette de marché de 520.000\s€ à 590.000\s€/,
    );
  });

  it("n'apparaît pas avec un seul montant", () => {
    const { container } = render(
      <PriceScale
        startingPrice={450_000}
        startLabel="Mise à prix"
        ceiling={null}
        value={null}
        range={null}
      />,
    );
    expect(container.firstChild).toBeNull();
    expect(priceScaleBounds([450_000])).toBeNull();
  });

  it("encadre les montants de 10 % de marge, arrondie au millier", () => {
    expect(priceScaleBounds([450_000, 590_000])).toEqual({ min: 436_000, max: 604_000 });
  });
});

describe("ceilingStartGapLabel", () => {
  it("dit l'écart sans conseil", () => {
    expect(ceilingStartGapLabel(12_500)).toMatch(/^12.500\s€ au-dessus de la mise à prix$/);
    expect(ceilingStartGapLabel(-8_000)).toMatch(
      /^8.000\s€ sous la mise à prix, à ces hypothèses$/,
    );
    expect(ceilingStartGapLabel(0, "première offre possible")).toBe(
      "Égale à la première offre possible",
    );
  });
});
