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

import { SaleRemindersToggle } from "./SaleRemindersToggle";

function preferences(overrides: { enabled?: boolean; available?: boolean } = {}) {
  return {
    preferences: {
      alertEmailEnabled: false,
      saleRemindersEnabled: overrides.enabled ?? false,
      saleRemindersConsentedAt: overrides.enabled ? "2026-10-19T10:00:00Z" : null,
    },
    saleRemindersAvailable: overrides.available ?? true,
  };
}

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SaleRemindersToggle userId="u1" className="ligne" />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("SaleRemindersToggle", () => {
  it("propose la case décochée, avec un libellé court, la portée et la mention à vérifier", async () => {
    mocks.preferences.mockResolvedValue(preferences());
    setup();
    const checkbox = (await screen.findByRole("checkbox")) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    const text = document.body.textContent ?? "";
    expect(text).toContain("Me rappeler l’audience (7 jours avant et la veille)");
    expect(text).toContain("Me prévenir si la date change ou si la vente est retirée");
    expect(text).toContain("reportée, annulée ou adjugée");
    expect(text).toContain("à vérifier auprès de l’avocat poursuivant");
    // Un seul vocabulaire : plus l'ancien libellé long ni le mot « avertissements ».
    expect(text).not.toContain("Rappels d’audience et avertissements");
    expect(text).not.toMatch(/avertissement/i);
  });

  it("emploie « rappels d'audience » dans l'explication et les messages", async () => {
    mocks.preferences.mockResolvedValue(preferences({ enabled: true }));
    mocks.update.mockResolvedValue(preferences());
    setup();
    const checkbox = await screen.findByRole("checkbox");
    expect(document.body.textContent).toContain("Rappels d’audience activés.");
    fireEvent.click(checkbox);
    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith("Rappels d’audience retirés"));
  });

  it("marque la case occupée (aria-busy) sans la désactiver pendant l'enregistrement", async () => {
    mocks.preferences.mockResolvedValue(preferences());
    let finish: (value: unknown) => void = () => undefined;
    mocks.update.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    setup();
    const checkbox = (await screen.findByRole("checkbox")) as HTMLInputElement;
    expect(checkbox.getAttribute("aria-busy")).toBe("false");

    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox.getAttribute("aria-busy")).toBe("true"));
    expect(checkbox.disabled).toBe(false);

    // Un second clic pendant l'envoi n'envoie rien de plus.
    fireEvent.click(checkbox);
    expect(mocks.update).toHaveBeenCalledTimes(1);

    finish(preferences({ enabled: true }));
    await waitFor(() => expect(checkbox.getAttribute("aria-busy")).toBe("false"));
  });

  it("enregistre le consentement distinct des alertes, sans toucher aux alertes email", async () => {
    mocks.preferences.mockResolvedValue(preferences());
    mocks.update.mockResolvedValue(preferences({ enabled: true }));
    setup();
    fireEvent.click(await screen.findByRole("checkbox"));
    await waitFor(() => expect(mocks.update).toHaveBeenCalled());
    expect(mocks.update.mock.calls[0][0]).toEqual({
      saleRemindersEnabled: true,
      consentSource: "settings",
    });
    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith("Rappels d’audience activés"));
  });

  it("permet de retirer le consentement", async () => {
    mocks.preferences.mockResolvedValue(preferences({ enabled: true }));
    mocks.update.mockResolvedValue(preferences());
    setup();
    const checkbox = (await screen.findByRole("checkbox")) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    fireEvent.click(checkbox);
    await waitFor(() => expect(mocks.update).toHaveBeenCalled());
    expect(mocks.update.mock.calls[0][0]).toMatchObject({ saleRemindersEnabled: false });
    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith("Rappels d’audience retirés"));
  });

  it("ne propose rien quand l'envoi n'est pas ouvert à cette personne", async () => {
    mocks.preferences.mockResolvedValue(preferences({ available: false }));
    const { container } = setup();
    await waitFor(() => expect(mocks.preferences).toHaveBeenCalled());
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("garde la case pour retirer un consentement déjà donné quand l'envoi est suspendu", async () => {
    mocks.preferences.mockResolvedValue(preferences({ enabled: true, available: false }));
    setup();
    expect(await screen.findByRole("checkbox")).toBeTruthy();
    expect(document.body.textContent).toContain("envois sont suspendus");
  });

  it("affiche une erreur en français quand l'enregistrement échoue", async () => {
    mocks.preferences.mockResolvedValue(preferences());
    mocks.update.mockRejectedValue(new Error("hors ligne"));
    setup();
    fireEvent.click(await screen.findByRole("checkbox"));
    await waitFor(() => expect(mocks.error).toHaveBeenCalled());
  });
});
