// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyFavoriteDossier, type FavoriteDossier } from "@/lib/favorite-dossier-shared";
import { SaleFileCard } from "./SaleFileCard";

const mocks = vi.hoisted(() => ({
  auth: { user: { id: "user-1" } as { id: string } | null, loading: false },
  fetchDossier: vi.fn(),
  saveDossier: vi.fn(),
  preferences: vi.fn(),
  updatePreferences: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => mocks.auth }));
vi.mock("@/lib/client-api", () => ({
  fetchFavoriteDossier: mocks.fetchDossier,
  saveFavoriteDossier: mocks.saveDossier,
  fetchNotificationPreferences: mocks.preferences,
  updateNotificationPreferences: mocks.updatePreferences,
}));
vi.mock("@/lib/toast", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock("@/components/FavoriteButton", () => ({
  FavoriteButton: ({ saleId }: { saleId: string }) => <button>Suivre {saleId}</button>,
}));

const SALE_ID = "sale-1";

function followed(overrides: Partial<FavoriteDossier> = {}): { dossier: FavoriteDossier } {
  return {
    dossier: { ...emptyFavoriteDossier(SALE_ID), followed: true, ...overrides },
  };
}

function renderCard(calculatedCeiling: number | null = 185_000) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SaleFileCard saleId={SALE_ID} calculatedCeiling={calculatedCeiling} />
    </QueryClientProvider>,
  );
}

/** Préférences de notification : les rappels d'audience sont-ils proposés, et déjà consentis ? */
function remindersOffer(available: boolean, enabled = false) {
  mocks.preferences.mockResolvedValue({
    preferences: { alertEmailEnabled: false, saleRemindersEnabled: enabled },
    saleRemindersAvailable: available,
  });
}

beforeEach(() => {
  mocks.auth.user = { id: "user-1" };
  mocks.auth.loading = false;
  // Par défaut l'envoi des rappels n'est pas ouvert : la ligne de consentement n'apparaît pas.
  remindersOffer(false);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SaleFileCard (Mon dossier)", () => {
  it("n'affiche rien sans compte connecté", () => {
    mocks.auth.user = null;
    const { container } = renderCard();
    expect(container.innerHTML).toBe("");
    expect(mocks.fetchDossier).not.toHaveBeenCalled();
  });

  it("propose de suivre la vente avant d'enregistrer quoi que ce soit", async () => {
    mocks.fetchDossier.mockResolvedValue({ dossier: emptyFavoriteDossier(SALE_ID) });
    renderCard();

    expect(await screen.findByRole("button", { name: `Suivre ${SALE_ID}` })).toBeTruthy();
    expect(screen.getByText(/Suivez cette vente pour y enregistrer/)).toBeTruthy();
    expect(screen.queryByLabelText("Mon statut")).toBeNull();
  });

  it("affiche un dossier vide comme vide, avec le calcul à enregistrer", async () => {
    mocks.fetchDossier.mockResolvedValue(followed());
    renderCard();

    expect(await screen.findByText("Aucune enchère plafond enregistrée.")).toBeTruthy();
    expect((screen.getByLabelText("Mon statut") as HTMLSelectElement).value).toBe("");
    expect(
      screen.getByRole("button", { name: /Enregistrer mon plafond calculé \(185\s000\s€\)/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retirer mon plafond" })).toBeNull();
  });

  it("enregistre le résultat du calculateur sur le compte", async () => {
    mocks.fetchDossier.mockResolvedValue(followed());
    mocks.saveDossier.mockResolvedValue(
      followed({ bidCeilingEur: 185_000, bidCeilingSavedAt: "2026-10-19T10:00:00.000Z" }),
    );
    renderCard();

    fireEvent.click(await screen.findByRole("button", { name: /Enregistrer mon plafond calculé/ }));

    await waitFor(() =>
      expect(mocks.saveDossier).toHaveBeenCalledWith({
        data: { saleId: SALE_ID, bidCeilingEur: 185_000 },
      }),
    );
    expect(await screen.findByTestId("saved-ceiling")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId("saved-ceiling").textContent).toMatch(
        /185\s000\s€.*19 octobre 2026/,
      ),
    );
    expect(screen.getByText("C’est le résultat du calcul actuel.")).toBeTruthy();
    expect(mocks.toastSuccess).toHaveBeenCalled();
  });

  it("enregistre le statut choisi, et l'efface avec « Aucun statut »", async () => {
    mocks.fetchDossier.mockResolvedValue(followed());
    mocks.saveDossier
      .mockResolvedValueOnce(followed({ personalStatus: "bidding" }))
      .mockResolvedValueOnce(followed());
    renderCard();

    const select = (await screen.findByLabelText("Mon statut")) as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      "Aucun statut",
      "À surveiller",
      "Analyse en cours",
      "Je prépare mon enchère",
      "Remporté",
      "Non remporté",
      "Archivé",
    ]);
    fireEvent.change(select, { target: { value: "bidding" } });
    await waitFor(() =>
      expect(mocks.saveDossier).toHaveBeenNthCalledWith(1, {
        data: { saleId: SALE_ID, personalStatus: "bidding" },
      }),
    );
    await waitFor(() =>
      expect((screen.getByLabelText("Mon statut") as HTMLSelectElement).value).toBe("bidding"),
    );

    fireEvent.change(screen.getByLabelText("Mon statut"), { target: { value: "" } });
    await waitFor(() =>
      expect(mocks.saveDossier).toHaveBeenNthCalledWith(2, {
        data: { saleId: SALE_ID, personalStatus: null },
      }),
    );
  });

  it("dit quand le calcul actuel diffère du plafond enregistré, sans le remplacer seul", async () => {
    mocks.fetchDossier.mockResolvedValue(
      followed({ bidCeilingEur: 150_000, bidCeilingSavedAt: "2026-10-10T08:00:00.000Z" }),
    );
    renderCard(185_000);

    expect(await screen.findByText(/Le calcul actuel donne 185\s000\s€/)).toBeTruthy();
    expect(mocks.saveDossier).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Retirer mon plafond" })).toBeTruthy();
  });

  it("retire le plafond enregistré", async () => {
    mocks.fetchDossier.mockResolvedValue(
      followed({ bidCeilingEur: 150_000, bidCeilingSavedAt: "2026-10-10T08:00:00.000Z" }),
    );
    mocks.saveDossier.mockResolvedValue(followed());
    renderCard(null);

    fireEvent.click(await screen.findByRole("button", { name: "Retirer mon plafond" }));
    await waitFor(() =>
      expect(mocks.saveDossier).toHaveBeenCalledWith({
        data: { saleId: SALE_ID, bidCeilingEur: null },
      }),
    );
    expect(await screen.findByText("Aucune enchère plafond enregistrée.")).toBeTruthy();
  });

  it("n'offre rien à enregistrer quand le calculateur n'est pas disponible pour ce compte", async () => {
    mocks.fetchDossier.mockResolvedValue(followed());
    renderCard(null);

    expect(await screen.findByText(/Aucun calcul d’enchère plafond n’est disponible/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Enregistrer mon plafond/ })).toBeNull();
    // Le statut reste enregistrable : le stockage est gratuit.
    expect(screen.getByLabelText("Mon statut")).toBeTruthy();
  });

  it("dit que le calcul est en cours plutôt que de le déclarer indisponible", async () => {
    mocks.fetchDossier.mockResolvedValue(followed());
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <SaleFileCard saleId={SALE_ID} calculatedCeiling={null} calculationPending />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Calcul de l’enchère plafond en cours…")).toBeTruthy();
    expect(screen.queryByText(/n’est disponible/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Enregistrer mon plafond/ })).toBeNull();
  });

  it("annonce l'échec d'un enregistrement et garde l'état affiché", async () => {
    mocks.fetchDossier.mockResolvedValue(followed());
    mocks.saveDossier.mockRejectedValue(new Error("Enregistrement impossible pour le moment."));
    renderCard();

    fireEvent.click(await screen.findByRole("button", { name: /Enregistrer mon plafond calculé/ }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(screen.getByText("Aucune enchère plafond enregistrée.")).toBeTruthy();
  });

  describe("rappels d'audience", () => {
    it("propose le consentement, décoché, quand l'envoi est ouvert et la vente suivie", async () => {
      remindersOffer(true);
      mocks.fetchDossier.mockResolvedValue(followed());
      mocks.updatePreferences.mockResolvedValue({});
      renderCard();

      const checkbox = (await screen.findByRole("checkbox")) as HTMLInputElement;
      expect(checkbox.checked).toBe(false);
      expect(screen.getByText("Me rappeler l’audience (7 jours avant et la veille)")).toBeTruthy();

      fireEvent.click(checkbox);
      await waitFor(() =>
        expect(mocks.updatePreferences.mock.calls[0][0]).toEqual({
          saleRemindersEnabled: true,
          consentSource: "settings",
        }),
      );
    });

    it("ne propose rien quand l'envoi n'est pas ouvert", async () => {
      remindersOffer(false);
      mocks.fetchDossier.mockResolvedValue(followed());
      renderCard();

      expect(await screen.findByLabelText("Mon statut")).toBeTruthy();
      await waitFor(() => expect(mocks.preferences).toHaveBeenCalled());
      expect(screen.queryByRole("checkbox")).toBeNull();
    });

    it("ne propose rien tant que la vente n'est pas suivie", async () => {
      remindersOffer(true);
      mocks.fetchDossier.mockResolvedValue({ dossier: emptyFavoriteDossier(SALE_ID) });
      renderCard();

      expect(await screen.findByRole("button", { name: `Suivre ${SALE_ID}` })).toBeTruthy();
      expect(screen.queryByRole("checkbox")).toBeNull();
    });
  });

  it("propose de réessayer quand le dossier ne se charge pas", async () => {
    mocks.fetchDossier.mockRejectedValueOnce(new Error("Dossier indisponible pour le moment."));
    mocks.fetchDossier.mockResolvedValueOnce(followed());
    renderCard();

    fireEvent.click(await screen.findByRole("button", { name: "Réessayer" }));
    expect(await screen.findByLabelText("Mon statut")).toBeTruthy();
  });
});
