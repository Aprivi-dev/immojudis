// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdminInformationAgentAutoPublicationPanel,
  AutoPublicationDecisionNote,
} from "./AdminInformationAgentAutoPublicationPanel";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), run: vi.fn() }));

vi.mock("@/lib/client-api/admin-auto-publication", () => ({
  fetchAdminAutoPublication: mocks.fetch,
  runAdminAutoPublicationActionClient: mocks.run,
}));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function view(overrides: Record<string, unknown> = {}) {
  return {
    mode: "off",
    modeLabel: "Arrêt",
    autoLocked: true,
    lockReasons: [
      "textes juridiques mis à jour et publiés",
      "AIPD mise à jour et signée",
      "validation des huit points par un avocat",
      "jeu d’évaluation à zéro publication fausse",
      "période de simulation concluante",
    ],
    eligibleFields: ["surface", "surface du terrain", "nombre de pièces"],
    caps: { daily: 10, perCase: 2 },
    changes: [],
    ...overrides,
  };
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AdminInformationAgentAutoPublicationPanel />
    </QueryClientProvider>,
  );
}

describe("AdminInformationAgentAutoPublicationPanel", () => {
  it("affiche le mode, l'automatique verrouillé avec ses conditions, et les plafonds", async () => {
    mocks.fetch.mockResolvedValue(view());
    renderPanel();
    expect(await screen.findByText("Arrêt", { selector: "strong" })).toBeTruthy();
    const locked = screen.getByRole("button", { name: "Automatique (verrouillé)" });
    expect((locked as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("AIPD mise à jour et signée")).toBeTruthy();
    expect(screen.getByText("validation des huit points par un avocat")).toBeTruthy();
    expect(screen.getByText(/10 par jour, 2 par dossier/)).toBeTruthy();
    // En mode arrêt, ni « Arrêt » ni l'arrêt d'urgence ne sont proposés.
    expect(
      (screen.getByRole("button", { name: "Arrêt d’urgence" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("lance la simulation, puis l'arrêt d'urgence en un geste", async () => {
    mocks.fetch.mockResolvedValue(view());
    mocks.run.mockResolvedValueOnce(view({ mode: "simulation", modeLabel: "Simulation" }));
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Simulation" }));
    await waitFor(() =>
      expect(mocks.run).toHaveBeenCalledWith(
        { action: "set_mode", mode: "simulation" },
        expect.anything(),
      ),
    );
    mocks.run.mockResolvedValueOnce(view());
    const stop = await screen.findByRole("button", { name: "Arrêt d’urgence" });
    await waitFor(() => expect((stop as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(stop);
    await waitFor(() =>
      expect(mocks.run).toHaveBeenLastCalledWith({ action: "emergency_stop" }, expect.anything()),
    );
  });
});

describe("AdminInformationAgentAutoPublicationPanel : arrêt d'urgence sans lecture", () => {
  it("garde l'arrêt d'urgence affiché et utilisable quand la lecture du réglage échoue", async () => {
    mocks.fetch.mockRejectedValue(new Error("Réglage illisible"));
    mocks.run.mockResolvedValueOnce(view());
    renderPanel();
    expect(await screen.findByText(/Réglage indisponible/)).toBeTruthy();
    const stop = screen.getByRole("button", { name: "Arrêt d’urgence" }) as HTMLButtonElement;
    expect(stop.disabled).toBe(false);
    fireEvent.click(stop);
    await waitFor(() =>
      expect(mocks.run).toHaveBeenCalledWith({ action: "emergency_stop" }, expect.anything()),
    );
  });
});

describe("AutoPublicationDecisionNote", () => {
  it("affiche « aurait été publié » ou « relecture » avec les raisons en clair", () => {
    render(
      <AutoPublicationDecisionNote
        decision={{
          outcome: "would_publish",
          label: "Aurait été publié",
          reasons: [],
          recorded: true,
          decidedAt: "2026-11-20T09:00:00.000Z",
        }}
      />,
    );
    expect(
      screen.getByText("Simulation : aurait été publié, le 20 nov. 2026, 10:00."),
    ).toBeTruthy();
    cleanup();
    render(
      <AutoPublicationDecisionNote
        decision={{
          outcome: "review",
          label: "Relecture",
          reasons: ["plafond atteint : 10 informations par jour"],
          recorded: true,
          decidedAt: null,
        }}
      />,
    );
    expect(
      screen.getByText("Simulation : relecture (plafond atteint : 10 informations par jour)."),
    ).toBeTruthy();
    cleanup();
    render(<AutoPublicationDecisionNote decision={undefined} />);
    expect(screen.getByText("Simulation : décision du moteur pas encore calculée.")).toBeTruthy();
  });
});
