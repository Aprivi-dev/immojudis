// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SavedAlerts } from "./SavedAlerts";
const state = vi.hoisted(() => ({
  userId: "first",
  list: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  create: vi.fn(),
  plan: { hasAnalysisAccess: false },
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { id: state.userId }, loading: false }),
}));
vi.mock("@/lib/queries", () => ({
  getAlerts: state.list,
  updateAlert: state.update,
  deleteAlert: state.remove,
  createAlert: state.create,
}));
vi.mock("@/lib/client-api", () => ({
  fetchWatchedZones: async () => ({ zones: [] }),
  deleteWatchedZone: vi.fn(),
  createWatchedZone: vi.fn(),
  evaluateAlertMatches: vi.fn(),
  fetchAccessPlan: async () => ({ plan: state.plan }),
}));
vi.mock("sonner", () => ({ toast: state.toast }));
afterEach(cleanup);
beforeEach(() => {
  state.userId = "first";
  vi.clearAllMocks();
  state.list.mockImplementation(async (id: string) => [
    {
      id: `alert-${id}`,
      name: `Alerte ${id}`,
      is_active: true,
      alert_frequency: "daily",
      city: "Bordeaux",
      department: "33",
      max_price_eur: 150000,
      dpe_classes: [],
      advanced_criteria: {},
    },
  ]);
  state.update.mockResolvedValue(undefined);
  state.remove.mockResolvedValue(undefined);
  state.create.mockResolvedValue(undefined);
  state.plan = { hasAnalysisAccess: false };
});
function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = () => (
    <QueryClientProvider client={client}>
      <SavedAlerts />
    </QueryClientProvider>
  );
  return { ...render(view()), view };
}
describe("saved alert management", () => {
  it("isolates accounts and pauses only the current user's alert", async () => {
    const ui = setup();
    await screen.findByText("Alerte first");
    state.userId = "second";
    ui.rerender(ui.view());
    expect(screen.queryByText("Alerte first")).toBeNull();
    await screen.findByText("Alerte second");
    fireEvent.click(screen.getByRole("button", { name: "Mettre en pause" }));
    await waitFor(() =>
      expect(state.update).toHaveBeenCalledWith("second", "alert-second", { is_active: false }),
    );
  });
  it("does not present a failed fetch as an empty alert list", async () => {
    state.list.mockRejectedValue(new Error("unavailable"));
    setup();
    await screen.findByRole("alert");
    expect(screen.queryByText("Aucune alerte enregistrée.")).toBeNull();
  });

  it("affiche les critères de l'alerte et jamais « Immédiate »", async () => {
    state.list.mockResolvedValue([
      {
        id: "alert-1",
        name: "Bordeaux",
        is_active: true,
        alert_frequency: "instant",
        city: "Bordeaux",
        department: "33",
        max_price_eur: 150000,
        min_surface_m2: 40,
        dpe_classes: [],
        advanced_criteria: {},
      },
    ]);
    setup();
    await screen.findByText("Lieu : Bordeaux, 33");
    expect(screen.getByText("Surface minimale : 40 m²")).toBeTruthy();
    expect(screen.queryByText(/Immédiate/i)).toBeNull();
    expect(screen.getAllByText("Quotidienne").length).toBeGreaterThan(0);
    expect(screen.getByText(/un seul email récapitulatif par jour/)).toBeTruthy();
  });

  it("change la fréquence et réserve l'hebdomadaire à l'offre Analyse", async () => {
    setup();
    const select = (await screen.findByLabelText(
      /Fréquence de l’alerte Alerte first/,
    )) as HTMLSelectElement;
    const weekly = Array.from(select.options).find((option) => option.value === "weekly")!;
    expect(weekly.disabled).toBe(true);
    cleanup();

    state.plan = { hasAnalysisAccess: true };
    setup();
    const enabled = (await screen.findByLabelText(
      /Fréquence de l’alerte Alerte first/,
    )) as HTMLSelectElement;
    await waitFor(() =>
      expect(Array.from(enabled.options).find((o) => o.value === "weekly")!.disabled).toBe(false),
    );
    fireEvent.change(enabled, { target: { value: "weekly" } });
    await waitFor(() =>
      expect(state.update).toHaveBeenCalledWith("first", "alert-first", {
        alert_frequency: "weekly",
      }),
    );
  });

  it("modifie une alerte", async () => {
    setup();
    await screen.findByText("Alerte first");
    fireEvent.click(screen.getByRole("button", { name: "Modifier" }));
    fireEvent.change(screen.getByLabelText("Nom de l’alerte"), {
      target: { value: "Ma recherche" },
    });
    fireEvent.change(screen.getByLabelText(/Mise à prix maximale/), {
      target: { value: "200000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
    await waitFor(() =>
      expect(state.update).toHaveBeenCalledWith("first", "alert-first", {
        name: "Ma recherche",
        alert_frequency: "daily",
        max_price_eur: 200000,
        min_surface_m2: null,
      }),
    );
  });

  it("annonce « Alerte supprimée » avec un bouton Annuler de 5 secondes qui rétablit l'alerte", async () => {
    setup();
    await screen.findByText("Alerte first");
    fireEvent.click(screen.getByRole("button", { name: "Supprimer l’alerte" }));
    await waitFor(() => expect(state.remove).toHaveBeenCalledWith("first", "alert-first"));
    await waitFor(() => expect(state.toast).toHaveBeenCalled());
    const [message, options] = state.toast.mock.calls[0];
    expect(message).toBe("Alerte supprimée");
    expect(options.duration).toBe(5000);
    expect(options.action.label).toBe("Annuler");
    options.action.onClick();
    await waitFor(() =>
      expect(state.create).toHaveBeenCalledWith(
        "first",
        expect.objectContaining({ name: "Alerte first", city: "Bordeaux", max_price_eur: 150000 }),
      ),
    );
  });
});
