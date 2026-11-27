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
  it("affiche le mode et les plafonds ; « Automatique » n'est proposé qu'après la confirmation", async () => {
    mocks.fetch.mockResolvedValue(view());
    mocks.run.mockResolvedValueOnce(view({ mode: "auto", modeLabel: "Automatique" }));
    renderPanel();
    expect(await screen.findByText("Arrêt", { selector: "strong" })).toBeTruthy();
    expect(screen.queryByText(/verrouillé/)).toBeNull();
    expect(screen.getByText(/10 par jour, 2 par dossier/)).toBeTruthy();
    // En mode arrêt, ni « Arrêt » ni l'arrêt d'urgence ne sont proposés.
    expect(
      (screen.getByRole("button", { name: "Arrêt d’urgence" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    const auto = screen.getByRole("button", { name: "Automatique" }) as HTMLButtonElement;
    expect(auto.disabled).toBe(true);
    fireEvent.click(
      screen.getByRole("checkbox", { name: /publiées sur les fiches sans relecture/ }),
    );
    expect(auto.disabled).toBe(false);
    fireEvent.click(auto);
    await waitFor(() =>
      expect(mocks.run).toHaveBeenCalledWith(
        { action: "set_mode", mode: "auto" },
        expect.anything(),
      ),
    );
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
          arbiterReason: null,
          recorded: true,
          decidedAt: "2026-11-20T09:00:00.000Z",
        }}
        simulation
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
          label: "À relire",
          reasons: ["plafond atteint : 10 informations par jour"],
          arbiterReason: null,
          recorded: true,
          decidedAt: null,
        }}
        simulation
      />,
    );
    expect(
      screen.getByText("Simulation : à relire (plafond atteint : 10 informations par jour)."),
    ).toBeTruthy();
    cleanup();
    render(<AutoPublicationDecisionNote decision={undefined} simulation />);
    expect(screen.getByText("Simulation : décision du moteur pas encore calculée.")).toBeTruthy();
  });

  it("mode automatique : « Publié automatiquement le … » ou « À relire (raisons) », motif de l'IA compris", () => {
    render(
      <AutoPublicationDecisionNote
        decision={{
          outcome: "published",
          label: "Publié automatiquement",
          reasons: [],
          arbiterReason: null,
          recorded: true,
          decidedAt: "2026-11-27T09:00:00.000Z",
        }}
        simulation={false}
      />,
    );
    expect(screen.getByText("Publié automatiquement le 27 nov. 2026, 10:00.")).toBeTruthy();
    cleanup();
    render(
      <AutoPublicationDecisionNote
        decision={{
          outcome: "review",
          label: "À relire",
          reasons: ["l’IA (Claude Haiku) ne confirme pas la publication"],
          arbiterReason: "valeur au conditionnel ou approximative",
          recorded: true,
          decidedAt: null,
        }}
        simulation={false}
      />,
    );
    expect(
      screen.getByText(
        "À relire (l’IA (Claude Haiku) ne confirme pas la publication ; motif de l’IA : valeur au conditionnel ou approximative).",
      ),
    ).toBeTruthy();
  });
});
