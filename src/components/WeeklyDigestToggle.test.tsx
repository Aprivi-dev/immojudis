// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  preferences: vi.fn(),
  update: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/lib/client-api", () => ({
  fetchNotificationPreferences: mocks.preferences,
  updateNotificationPreferences: mocks.update,
}));
vi.mock("@/lib/toast", () => ({ toast: { success: mocks.success, error: mocks.error } }));

import { WeeklyDigestToggle } from "./WeeklyDigestToggle";

function preferences(overrides: { enabled?: boolean; available?: boolean; weekday?: number } = {}) {
  return {
    preferences: {
      alertEmailEnabled: false,
      saleRemindersEnabled: false,
      weeklyDigestEnabled: overrides.enabled ?? false,
      weeklyDigestConsentedAt: overrides.enabled ? "2026-10-21T10:00:00Z" : null,
      weeklyDigestWeekday: overrides.weekday ?? 2,
    },
    saleRemindersAvailable: true,
    weeklyDigestAvailable: overrides.available ?? true,
    saleResultsAvailable: false,
  };
}

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <WeeklyDigestToggle userId="u1" className="ligne" />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("WeeklyDigestToggle", () => {
  it("propose la case décochée, avec ce que contient le récapitulatif, sans jour tant qu'il n'est pas activé", async () => {
    mocks.preferences.mockResolvedValue(preferences());
    setup();
    const checkbox = (await screen.findByRole("checkbox")) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    const text = document.body.textContent ?? "";
    expect(text).toContain("Ma semaine");
    expect(text).toContain("audiences des 14 prochains jours");
    expect(text).toContain("nouvelles ventes de mon département");
    expect(text).toContain("à vérifier auprès de l’avocat poursuivant");
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("annonce le retrait avant la case et dit qu'aucun envoi n'est garanti", async () => {
    mocks.preferences.mockResolvedValue(preferences());
    setup();
    const checkbox = await screen.findByRole("checkbox");
    const retrait = screen.getByText(
      "Retirable à tout moment, ici ou par le lien de désinscription de chaque email.",
    );
    expect(
      retrait.compareDocumentPosition(checkbox) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(document.body.textContent).toContain(
      "Les envois dépendent des informations publiées par les sources ; aucun envoi n’est garanti.",
    );
  });

  it("enregistre le consentement distinct, sans toucher aux alertes ni aux rappels", async () => {
    mocks.preferences.mockResolvedValue(preferences());
    mocks.update.mockResolvedValue(preferences({ enabled: true }));
    setup();
    fireEvent.click(await screen.findByRole("checkbox"));
    await waitFor(() => expect(mocks.update).toHaveBeenCalled());
    expect(mocks.update.mock.calls[0][0]).toEqual({
      weeklyDigestEnabled: true,
      consentSource: "settings",
    });
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith("Récapitulatif hebdomadaire activé"),
    );
  });

  it("permet de retirer le consentement", async () => {
    mocks.preferences.mockResolvedValue(preferences({ enabled: true }));
    mocks.update.mockResolvedValue(preferences());
    setup();
    const checkbox = (await screen.findByRole("checkbox")) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    fireEvent.click(checkbox);
    await waitFor(() => expect(mocks.update).toHaveBeenCalled());
    expect(mocks.update.mock.calls[0][0]).toMatchObject({ weeklyDigestEnabled: false });
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith("Récapitulatif hebdomadaire retiré"),
    );
  });

  it("propose le jour d'envoi une fois activé, le mardi par défaut, et l'enregistre", async () => {
    mocks.preferences.mockResolvedValue(preferences({ enabled: true }));
    mocks.update.mockResolvedValue(preferences({ enabled: true, weekday: 4 }));
    setup();
    const select = (await screen.findByRole("combobox", {
      name: "Jour d’envoi",
    })) as HTMLSelectElement;
    expect(select.value).toBe("2");
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      "lundi",
      "mardi",
      "mercredi",
      "jeudi",
      "vendredi",
      "samedi",
      "dimanche",
    ]);
    fireEvent.change(select, { target: { value: "4" } });
    await waitFor(() => expect(mocks.update).toHaveBeenCalled());
    // Le jour seul est envoyé : aucun consentement n'est modifié.
    expect(mocks.update.mock.calls[0][0]).toEqual({
      weeklyDigestWeekday: 4,
      consentSource: "settings",
    });
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith("Jour du récapitulatif enregistré"),
    );
  });

  it("marque la case occupée (aria-busy) sans la désactiver et ignore un second clic", async () => {
    mocks.preferences.mockResolvedValue(preferences());
    let finish: (value: unknown) => void = () => undefined;
    mocks.update.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    setup();
    const checkbox = (await screen.findByRole("checkbox")) as HTMLInputElement;
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox.getAttribute("aria-busy")).toBe("true"));
    expect(checkbox.disabled).toBe(false);
    fireEvent.click(checkbox);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    finish(preferences({ enabled: true }));
    await waitFor(() => expect(checkbox.getAttribute("aria-busy")).toBe("false"));
  });

  it("ne propose rien quand l'envoi n'est pas ouvert à cette personne", async () => {
    mocks.preferences.mockResolvedValue(preferences({ available: false }));
    const { container } = setup();
    await waitFor(() => expect(mocks.preferences).toHaveBeenCalled());
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("ne propose rien quand la réponse ne dit pas que l'envoi est ouvert", async () => {
    mocks.preferences.mockResolvedValue({ preferences: { alertEmailEnabled: false } });
    const { container } = setup();
    await waitFor(() => expect(mocks.preferences).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("garde la case visible pour retirer un consentement quand l'envoi est fermé", async () => {
    mocks.preferences.mockResolvedValue(preferences({ enabled: true, available: false }));
    setup();
    const checkbox = (await screen.findByRole("checkbox")) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    expect(document.body.textContent).toContain("envois sont suspendus");
  });
});
