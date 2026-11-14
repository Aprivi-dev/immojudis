// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminInformationAgentAutopilotPanel } from "./AdminInformationAgentAutopilotPanel";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  run: vi.fn(),
  simulate: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock("@/lib/client-api", () => ({
  fetchAdminInformationAgentAutopilot: mocks.fetch,
  runAdminInformationAgentAutopilotActionClient: mocks.run,
  runAdminInformationAgentAutopilotSimulationClient: mocks.simulate,
}));
vi.mock("@/lib/toast", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError, info: mocks.toastInfo },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

function view(overrides: Record<string, unknown> = {}) {
  return {
    mode: "off",
    modeLabel: "Éteint",
    runs: "Dernier passage : 16/11/2026 09:40 · prochain passage : 16/11/2026 09:50",
    notice: null,
    counters: [{ label: "Envois aujourd’hui (manuels inclus)", value: "2 sur 5" }],
    settings: {
      actingAdminId: null,
      capTotalOverride: null,
      allowLicitorDecoded: false,
      art14RuleEnabled: true,
      art14MaxAgeDays: 30,
      art14Label:
        "appliqué à chaque candidat, non désactivable · délai d’information : 30 jours (réglable de 1 à 90)",
      aipdLabel: "Non attestée",
    },
    readiness: {
      ready: false,
      checks: [{ label: "AIPD attestée", ok: false, detail: "Aucune attestation d’AIPD." }],
    },
    ready: {
      count: 1,
      label: "Prêtes à valider (1 sur 10 au plus)",
      notice: null,
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

  it("mode Simulation : lance un passage avec le motif, affiche le résultat, puis relit l'état", async () => {
    const simulation = { mode: "simulation", modeLabel: "Simulation (aucun envoi)" };
    mocks.fetch.mockResolvedValue(view(simulation));
    mocks.simulate.mockResolvedValue({
      onDemandRun: {
        outcome: "finished",
        text: "Passage de simulation terminé : 3 examinées, 1 préparée, 1 simulée. Aucun envoi.",
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

    await waitFor(() => expect(mocks.simulate).toHaveBeenCalledTimes(1));
    expect(mocks.simulate.mock.calls[0][0]).toBe("Premier passage demandé");
    expect(mocks.run).not.toHaveBeenCalled();
    expect((await screen.findByRole("status")).textContent).toBe(
      "Passage de simulation terminé : 3 examinées, 1 préparée, 1 simulée. Aucun envoi.",
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Passage de simulation terminé.");
    // L'état du pilote est relu après le passage.
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
    // Le motif se vide après l'action : le bouton redevient grisé, et l'écran dit pourquoi.
    expect((launch as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Saisissez un motif de 8 caractères au moins/)).toBeTruthy();
  });

  it.each([
    ["time_budget", "Passage de simulation arrêté par la borne de temps."],
    ["interrupted", "Passage de simulation interrompu."],
  ])("résultat %s : le toast le distingue d'un passage terminé", async (outcome, toastText) => {
    mocks.fetch.mockResolvedValue(view({ mode: "simulation", modeLabel: "Simulation" }));
    mocks.simulate.mockResolvedValue({ onDemandRun: { outcome, text: "Résultat du passage." } });
    renderPanel();

    fireEvent.change(await screen.findByLabelText(/Motif du changement/), {
      target: { value: "Premier passage demandé" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Lancer un passage de simulation" }));

    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith(toastText));
  });

  it("un passage refusé affiche son motif à côté du bouton", async () => {
    mocks.fetch.mockResolvedValue(view({ mode: "simulation", modeLabel: "Simulation" }));
    mocks.simulate.mockRejectedValue(
      Object.assign(
        new Error("Un passage à la demande a déjà été lancé il y a moins de 10 minutes."),
        { status: 429 },
      ),
    );
    renderPanel();

    fireEvent.change(await screen.findByLabelText(/Motif du changement/), {
      target: { value: "Deuxième passage demandé" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Lancer un passage de simulation" }));

    expect((await screen.findByRole("alert")).textContent).toContain("il y a moins de 10 minutes");
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
  });

  it("délai des routes admin dépassé (504) : une information, pas un refus, et l'état est relu", async () => {
    mocks.fetch.mockResolvedValue(view({ mode: "simulation", modeLabel: "Simulation" }));
    const message =
      "Cette action admin a dépassé le délai de 30 secondes. Elle a pu aboutir malgré tout : actualisez la liste et vérifiez son état avant de la relancer.";
    mocks.simulate.mockRejectedValue(Object.assign(new Error(message), { status: 504 }));
    renderPanel();

    fireEvent.change(await screen.findByLabelText(/Motif du changement/), {
      target: { value: "Premier passage demandé" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Lancer un passage de simulation" }));

    expect((await screen.findByRole("status")).textContent).toBe(message);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(mocks.toastInfo).toHaveBeenCalledWith(message);
    expect(mocks.toastError).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
  });

  it("dit que le pilote est indisponible plutôt que d'afficher un état inventé", async () => {
    mocks.fetch.mockRejectedValue(new Error("boom"));
    renderPanel();
    expect((await screen.findByRole("alert")).textContent).toContain("indisponible");
  });

  it("dit le dernier passage et le prochain, et le plafond des brouillons prêts à valider", async () => {
    mocks.fetch.mockResolvedValue(
      view({
        ready: {
          count: 10,
          label: "Prêtes à valider (10 sur 10 au plus)",
          notice: "Plafond atteint : la simulation ne prépare plus de brouillon.",
          items: [],
        },
      }),
    );
    renderPanel();
    expect(
      await screen.findByText(
        "Dernier passage : 16/11/2026 09:40 · prochain passage : 16/11/2026 09:50",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Prêtes à valider (10 sur 10 au plus)")).toBeTruthy();
    expect(screen.getByText(/^Plafond atteint/)).toBeTruthy();
  });

  it("réglages du pilote : un bouton qui dit l'action sur les adresses Licitor décodées (P3)", async () => {
    mocks.fetch.mockResolvedValue(view());
    mocks.run.mockResolvedValue(view());
    renderPanel();
    await screen.findByText("Réglages du pilote");
    expect(screen.getByText("fermées au pilote")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Motif du changement/), {
      target: { value: "Accord écrit de Licitor reçu" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ouvrir les adresses Licitor décodées" }));
    await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
    expect(mocks.run.mock.calls[0][0]).toEqual({
      action: "update_settings",
      reason: "Accord écrit de Licitor reçu",
      changes: { allowLicitorDecoded: true },
    });
    cleanup();

    mocks.fetch.mockResolvedValue(
      view({ settings: { ...view().settings, allowLicitorDecoded: true } }),
    );
    renderPanel();
    expect(
      await screen.findByRole("button", { name: "Fermer les adresses Licitor décodées" }),
    ).toBeTruthy();
    expect(screen.getByText("ouvertes au pilote")).toBeTruthy();
  });

  it("conformité : l'article 14 ne se désactive pas, son délai change après confirmation (J9)", async () => {
    mocks.fetch.mockResolvedValue(view());
    mocks.run.mockResolvedValue(view());
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPanel();
    await screen.findByText("Conformité (article 14, AIPD)");
    expect(screen.getByText(/appliqué à chaque candidat, non désactivable/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Article 14 :/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Rétablir la règle/ })).toBeNull();

    fireEvent.change(screen.getByLabelText(/Motif du changement/), {
      target: { value: "Délai réduit après avis" },
    });
    const change = screen.getByRole("button", { name: "Modifier le délai de l’article 14" });
    // Hors de 1 à 90 jours : le bouton reste grisé ; 90 est admis (décision du 14/11/2026).
    for (const value of ["91", "0", "abc"]) {
      fireEvent.change(screen.getByLabelText("Délai en jours"), { target: { value } });
      expect((change as HTMLButtonElement).disabled, value).toBe(true);
    }
    fireEvent.change(screen.getByLabelText("Délai en jours"), { target: { value: "90" } });
    expect((change as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("Délai en jours"), { target: { value: "20" } });
    // Annulé : rien n'est envoyé.
    fireEvent.click(change);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("de 30 à 20 jours"));
    expect(mocks.run).not.toHaveBeenCalled();
    // Confirmé : le délai part avec le motif.
    confirm.mockReturnValue(true);
    fireEvent.click(change);
    await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
    expect(mocks.run.mock.calls[0][0]).toEqual({
      action: "update_settings",
      reason: "Délai réduit après avis",
      changes: { art14MaxAgeDays: 20 },
    });
  });

  it("conformité : une règle de l'article 14 coupée avant la contrainte se rétablit, après confirmation", async () => {
    mocks.fetch.mockResolvedValue(
      view({ settings: { ...view().settings, art14RuleEnabled: false } }),
    );
    mocks.run.mockResolvedValue(view());
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPanel();
    fireEvent.change(await screen.findByLabelText(/Motif du changement/), {
      target: { value: "Rétablir la règle" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rétablir la règle de l’article 14" }));
    await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
    expect(mocks.run.mock.calls[0][0]).toMatchObject({ changes: { art14RuleEnabled: true } });
  });

  it("conformité : attester l'AIPD demande une confirmation explicite", async () => {
    mocks.fetch.mockResolvedValue(view());
    mocks.run.mockResolvedValue(view());
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPanel();
    fireEvent.change(await screen.findByLabelText(/Motif du changement/), {
      target: { value: "AIPD signée et versée" },
    });
    fireEvent.change(screen.getByLabelText("Version de l’AIPD"), { target: { value: "AIPD-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Attester l’AIPD" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("« AIPD-1 »"));
    expect(mocks.run).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Attester l’AIPD" }));
    await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
    expect(mocks.run.mock.calls[0][0]).toEqual({
      action: "attest_aipd",
      version: "AIPD-1",
      reason: "AIPD signée et versée",
    });
  });

  it("l'arrêt d'urgence a le style « danger », distinct de « Valider et envoyer » (P11)", async () => {
    mocks.fetch.mockResolvedValue(
      view({ mode: "simulation", modeLabel: "Simulation (aucun envoi)" }),
    );
    renderPanel();
    const stop = await screen.findByRole("button", { name: "Arrêt d’urgence" });
    expect(stop.className).toContain("admin-button-danger");
    expect(stop.className).not.toContain("admin-button-primary");
  });
});
