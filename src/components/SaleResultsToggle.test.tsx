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

import { SaleResultsToggle } from "./SaleResultsToggle";

function preferences(overrides: { enabled?: boolean; available?: boolean } = {}) {
  return {
    preferences: {
      alertEmailEnabled: false,
      saleRemindersEnabled: true,
      saleResultsEnabled: overrides.enabled ?? false,
      saleResultsConsentedAt: overrides.enabled ? "2026-10-21T10:00:00Z" : null,
    },
    saleRemindersAvailable: true,
    weeklyDigestAvailable: false,
    saleResultsAvailable: overrides.available ?? true,
  };
}

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SaleResultsToggle userId="u1" className="ligne" />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("SaleResultsToggle", () => {
  it("propose la case décochée, sans promettre de prix et avec la mention à vérifier", async () => {
    mocks.preferences.mockResolvedValue(preferences());
    setup();
    const checkbox = (await screen.findByRole("checkbox")) as HTMLInputElement;
    // Jamais pré-cochée, même quand les rappels d'audience le sont : consentement distinct.
    expect(checkbox.checked).toBe(false);
    const text = document.body.textContent ?? "";
    expect(text).toContain("Me prévenir du résultat ou de la remise en vente");
    expect(text).toContain("L’email ne donne aucun prix");
    expect(text).toContain("à vérifier auprès de l’avocat poursuivant");
  });

  it("enregistre le consentement distinct, sans toucher aux alertes ni aux rappels", async () => {
    mocks.preferences.mockResolvedValue(preferences());
    mocks.update.mockResolvedValue(preferences({ enabled: true }));
    setup();
    fireEvent.click(await screen.findByRole("checkbox"));
    await waitFor(() => expect(mocks.update).toHaveBeenCalled());
    expect(mocks.update.mock.calls[0][0]).toEqual({
      saleResultsEnabled: true,
      consentSource: "settings",
    });
    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith("Alertes de résultat activées"));
  });

  it("permet de retirer le consentement", async () => {
    mocks.preferences.mockResolvedValue(preferences({ enabled: true }));
    mocks.update.mockResolvedValue(preferences());
    setup();
    const checkbox = (await screen.findByRole("checkbox")) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    fireEvent.click(checkbox);
    await waitFor(() => expect(mocks.update).toHaveBeenCalled());
    expect(mocks.update.mock.calls[0][0]).toMatchObject({ saleResultsEnabled: false });
    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith("Alertes de résultat retirées"));
  });

  it("ne propose rien quand l'envoi n'est pas ouvert à cette personne", async () => {
    mocks.preferences.mockResolvedValue(preferences({ available: false }));
    const { container } = setup();
    await waitFor(() => expect(mocks.preferences).toHaveBeenCalled());
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("garde la case visible pour retirer un consentement quand l'envoi est fermé", async () => {
    mocks.preferences.mockResolvedValue(preferences({ enabled: true, available: false }));
    setup();
    expect(((await screen.findByRole("checkbox")) as HTMLInputElement).checked).toBe(true);
    expect(document.body.textContent).toContain("envois sont suspendus");
  });
});
