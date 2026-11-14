// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminInformationAgentAutopilotPanel } from "./AdminInformationAgentAutopilotPanel";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), run: vi.fn() }));

vi.mock("@/lib/client-api", () => ({
  fetchAdminInformationAgentAutopilot: mocks.fetch,
  runAdminInformationAgentAutopilotActionClient: mocks.run,
}));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function view(overrides: Record<string, unknown> = {}) {
  return {
    mode: "off",
    modeLabel: "Éteint",
    notice: null,
    counters: [{ label: "Envois aujourd’hui (manuels inclus)", value: "2 sur 5" }],
    settings: {
      actingAdminId: null,
      capTotalOverride: null,
      allowLicitorDecoded: false,
      art14RuleEnabled: true,
      art14MaxAgeDays: 30,
      aipdLabel: "Non attestée",
    },
    readiness: {
      ready: false,
      checks: [{ label: "AIPD attestée", ok: false, detail: "Aucune attestation d’AIPD." }],
    },
    ready: {
      count: 1,
      items: [{ missionId: "mission-1", saleId: "sale-1", label: "Appartement E2E à Bordeaux" }],
    },
    events: [{ at: "03/11/2026 10:40", label: "Passage", detail: "5 examinées" }],
    ...overrides,
  };
}

function renderPanel(onOpenDraft?: (draft: unknown) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AdminInformationAgentAutopilotPanel onOpenDraft={onOpenDraft} />
    </QueryClientProvider>,
  );
}

describe("AdminInformationAgentAutopilotPanel", () => {
  it("affiche l'état, les compteurs, le contrôle de préparation et les brouillons prêts à valider", async () => {
    mocks.fetch.mockResolvedValue(view());
    renderPanel();

    expect(await screen.findByText("Éteint", { selector: "strong" })).toBeTruthy();
    expect(screen.getByText("2 sur 5")).toBeTruthy();
    expect(screen.getByText(/Contrôle de préparation au mode réel : non satisfait/)).toBeTruthy();
    expect(screen.getByText("Appartement E2E à Bordeaux")).toBeTruthy();
  });

  it("une vente prête à valider ouvre son brouillon dans l'éditeur", async () => {
    mocks.fetch.mockResolvedValue(view());
    const onOpenDraft = vi.fn();
    renderPanel(onOpenDraft);

    fireEvent.click(await screen.findByRole("button", { name: "Appartement E2E à Bordeaux" }));

    expect(onOpenDraft).toHaveBeenCalledExactlyOnceWith({
      missionId: "mission-1",
      saleId: "sale-1",
      label: "Appartement E2E à Bordeaux",
    });
  });

  it("exige un motif de 8 caractères pour changer de mode, puis journalise le changement", async () => {
    mocks.fetch.mockResolvedValue(view());
    mocks.run.mockResolvedValue(
      view({ mode: "simulation", modeLabel: "Simulation (aucun envoi)" }),
    );
    renderPanel();

    const simulation = await screen.findByRole("button", { name: "Simulation" });
    expect((simulation as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Motif du changement/), {
      target: { value: "Début de la simulation" },
    });
    expect((simulation as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(simulation);

    await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
    expect(mocks.run.mock.calls[0][0]).toEqual({
      action: "set_mode",
      mode: "simulation",
      reason: "Début de la simulation",
    });
    expect(await screen.findByText("Simulation (aucun envoi)")).toBeTruthy();
  });

  it("l'arrêt d'urgence ne demande aucun motif et n'est actif que si le pilote tourne", async () => {
    mocks.fetch.mockResolvedValue(view({ mode: "live", modeLabel: "Réel" }));
    mocks.run.mockResolvedValue(view());
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Arrêt d’urgence" }));

    await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
    expect(mocks.run.mock.calls[0][0]).toEqual({ action: "emergency_stop" });
  });

  it("montre un arrêt automatique et garde l'arrêt d'urgence grisé quand le pilote est éteint", async () => {
    mocks.fetch.mockResolvedValue(
      view({
        notice: { tone: "alert", text: "Arrêt automatique le 03/11/2026 10:00 : une plainte." },
      }),
    );
    renderPanel();

    expect((await screen.findByRole("alert")).textContent).toContain("Arrêt automatique");
    expect(
      (screen.getByRole("button", { name: "Arrêt d’urgence" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("dit à côté du motif pourquoi les boutons sont grisés tant qu'il manque", async () => {
    mocks.fetch.mockResolvedValue(view());
    renderPanel();

    const reason = await screen.findByLabelText(/Motif du changement/);
    const hint = screen.getByText(/Saisissez un motif de 8 caractères au moins/);
    expect(reason.getAttribute("aria-describedby")).toBe(hint.id);
    fireEvent.change(reason, { target: { value: "Motif assez long" } });
    expect(screen.queryByText(/Saisissez un motif de 8 caractères au moins/)).toBeNull();
  });

  it.each([
    ["off", "Éteint"],
    ["live", "Réel"],
  ])("mode %s : aucun bouton de passage à la demande", async (mode, modeLabel) => {
    mocks.fetch.mockResolvedValue(view({ mode, modeLabel }));
    renderPanel();

    expect(await screen.findByText(modeLabel, { selector: "strong" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Lancer un passage de simulation" })).toBeNull();
  });

  it("mode Simulation : lance un passage avec le motif, puis affiche le résultat", async () => {
    const simulation = { mode: "simulation", modeLabel: "Simulation (aucun envoi)" };
    mocks.fetch.mockResolvedValue(view(simulation));
    mocks.run.mockResolvedValue({
      ...view(simulation),
      onDemandRun: {
        text: "Passage de simulation terminé : 3 examinées, 1 préparées, 1 simulées. Aucun envoi.",
      },
    });
    renderPanel();

    const launch = await screen.findByRole("button", { name: "Lancer un passage de simulation" });
    expect((launch as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Motif du changement/), {
      target: { value: "Premier passage demandé" },
    });
    expect((launch as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(launch);

    await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
    expect(mocks.run.mock.calls[0][0]).toEqual({
      action: "run_simulation_now",
      reason: "Premier passage demandé",
    });
    expect((await screen.findByRole("status")).textContent).toBe(
      "Passage de simulation terminé : 3 examinées, 1 préparées, 1 simulées. Aucun envoi.",
    );
    // Le motif se vide après l'action : le bouton redevient grisé, et l'écran dit pourquoi.
    expect((launch as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Saisissez un motif de 8 caractères au moins/)).toBeTruthy();
  });

  it("un passage refusé affiche son motif à côté du bouton", async () => {
    mocks.fetch.mockResolvedValue(view({ mode: "simulation", modeLabel: "Simulation" }));
    mocks.run.mockRejectedValue(
      new Error("Un passage à la demande a déjà été lancé il y a moins de 10 minutes."),
    );
    renderPanel();

    fireEvent.change(await screen.findByLabelText(/Motif du changement/), {
      target: { value: "Deuxième passage demandé" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Lancer un passage de simulation" }));

    expect((await screen.findByRole("alert")).textContent).toContain("il y a moins de 10 minutes");
  });

  it("dit que le pilote est indisponible plutôt que d'afficher un état inventé", async () => {
    mocks.fetch.mockRejectedValue(new Error("boom"));
    renderPanel();
    expect((await screen.findByRole("alert")).textContent).toContain("indisponible");
  });
});
