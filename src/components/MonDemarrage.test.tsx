// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startCardClosedKey } from "@/lib/start-checklist";
import { MonDemarrage } from "./MonDemarrage";

const mocks = vi.hoisted(() => ({
  auth: { user: { id: "user-1" } as { id: string } | null, loading: false },
  favorites: vi.fn(),
  preferences: vi.fn(),
  updatePreferences: vi.fn(),
  from: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => mocks.auth }));
vi.mock("@/lib/client-api", () => ({
  fetchNotificationPreferences: mocks.preferences,
  updateNotificationPreferences: mocks.updatePreferences,
}));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/integrations/supabase/lazy", () => ({
  getSupabase: async () => ({ from: mocks.from }),
}));

type Favorite = { sale_id: string; personal_status: string | null; bid_ceiling_eur: number | null };

function serveFavorites(rows: Favorite[]) {
  mocks.favorites.mockResolvedValue({ data: rows, error: null });
}

function serveReminders(available: boolean, enabled = false) {
  mocks.preferences.mockResolvedValue({
    preferences: { alertEmailEnabled: false, saleRemindersEnabled: enabled },
    saleRemindersAvailable: available,
  });
}

function renderCard() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MonDemarrage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.auth.user = { id: "user-1" };
  mocks.auth.loading = false;
  const query = {
    select: () => query,
    eq: () => query,
    order: () => query,
    limit: () => mocks.favorites(),
  };
  mocks.from.mockReturnValue(query);
  serveFavorites([]);
  serveReminders(false);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe("MonDemarrage", () => {
  it("n'affiche rien sans compte connecté et ne lit rien", () => {
    mocks.auth.user = null;
    const { container } = renderCard();
    expect(container.innerHTML).toBe("");
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("propose les deux premiers gestes à un compte sans favori, sans ligne de rappel tant que l'envoi est fermé", async () => {
    renderCard();

    const card = await screen.findByTestId("mon-demarrage");
    expect(card.textContent).toContain("Suivre une vente");
    expect(card.textContent).toContain("Noter mon statut ou mon enchère plafond");
    expect(card.textContent).not.toContain("Recevoir un rappel d’audience");
    expect(card.textContent).toContain("À faire : ");
    // Pas de lien « Mon dossier » sans favori.
    expect(screen.queryByRole("link", { name: /Ouvrir « Mon dossier »/ })).toBeNull();
  });

  it("n'annonce pas l'enchère plafond pour toutes les ventes", async () => {
    renderCard();

    const card = await screen.findByTestId("mon-demarrage");
    expect(card.textContent).toContain(
      "L’enchère plafond n’existe que pour les ventes au tribunal",
    );
    expect(card.textContent).not.toMatch(/toutes les ventes/i);
  });

  it("coche « Suivre une vente » dès un favori et ouvre « Mon dossier » (ancre #mon-dossier) de ce favori", async () => {
    serveFavorites([{ sale_id: "sale-1", personal_status: null, bid_ceiling_eur: null }]);
    renderCard();

    const link = await screen.findByRole("link", { name: "Ouvrir « Mon dossier »" });
    expect(link.getAttribute("href")).toBe("/sales/sale-1#mon-dossier");
    expect(screen.getByTestId("mon-demarrage").textContent).toContain("Fait : ");
  });

  it("propose la ligne du rappel d'audience quand l'envoi est ouvert, avec son consentement non coché", async () => {
    serveFavorites([{ sale_id: "sale-1", personal_status: "watching", bid_ceiling_eur: null }]);
    serveReminders(true, false);
    renderCard();

    const box = await screen.findByRole("checkbox");
    expect((box as HTMLInputElement).checked).toBe(false);
    expect(screen.getByTestId("mon-demarrage").textContent).toContain(
      "Recevoir un rappel d’audience",
    );
  });

  it("disparaît quand tout est fait", async () => {
    serveFavorites([{ sale_id: "sale-1", personal_status: null, bid_ceiling_eur: 185_000 }]);
    serveReminders(true, true);
    renderCard();

    await waitFor(() => expect(mocks.favorites).toHaveBeenCalled());
    await waitFor(() => expect(mocks.preferences).toHaveBeenCalled());
    // Laisse les deux lectures se résoudre : la carte ne s'est jamais affichée.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId("mon-demarrage")).toBeNull();
  });

  it("disparaît à la fermeture, mémorisée pour ce compte seulement", async () => {
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Fermer « Mon démarrage »" }));

    expect(screen.queryByTestId("mon-demarrage")).toBeNull();
    expect(window.localStorage.getItem(startCardClosedKey("user-1"))).toBe("1");

    cleanup();
    renderCard();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId("mon-demarrage")).toBeNull();

    // Un autre compte sur le même navigateur la revoit.
    cleanup();
    mocks.auth.user = { id: "user-2" };
    renderCard();
    expect(await screen.findByTestId("mon-demarrage")).toBeTruthy();
  });

  it("ne montre rien (et ne plante pas) si la lecture des favoris échoue", async () => {
    mocks.favorites.mockResolvedValue({ data: null, error: new Error("indisponible") });
    renderCard();

    await waitFor(() => expect(mocks.favorites).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId("mon-demarrage")).toBeNull();
  });

  it("fonctionne quand le stockage du navigateur est inaccessible", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    renderCard();

    fireEvent.click(await screen.findByRole("button", { name: "Fermer « Mon démarrage »" }));
    expect(screen.queryByTestId("mon-demarrage")).toBeNull();
    vi.restoreAllMocks();
  });
});
