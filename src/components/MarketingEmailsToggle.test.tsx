// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MARKETING_EMAILS_CONSENT_TEXT } from "@/lib/marketing-emails-consent";

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

import { MarketingEmailsToggle } from "./MarketingEmailsToggle";

function preferences(overrides: { enabled?: boolean; available?: boolean } = {}) {
  return {
    preferences: {
      alertEmailEnabled: true,
      weeklyDigestEnabled: true,
      marketingEmailsEnabled: overrides.enabled ?? false,
      marketingEmailsConsentedAt: overrides.enabled ? "2026-11-26T10:00:00Z" : null,
    },
    weeklyDigestAvailable: true,
    marketingEmailsAvailable: overrides.available ?? true,
  };
}

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MarketingEmailsToggle userId="u1" className="ligne" />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("MarketingEmailsToggle", () => {
  it("propose la case décochée, même quand les alertes et « Ma semaine » sont actives, avec le texte de /bienvenue", async () => {
    mocks.preferences.mockResolvedValue(preferences());
    setup();
    const checkbox = (await screen.findByRole("checkbox")) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect(document.body.textContent).toContain("Nouveautés et offres");
    expect(document.body.textContent).toContain(MARKETING_EMAILS_CONSENT_TEXT);
  });

  it("enregistre le consentement distinct, sans toucher aux autres", async () => {
    mocks.preferences.mockResolvedValue(preferences());
    mocks.update.mockResolvedValue(preferences({ enabled: true }));
    setup();
    fireEvent.click(await screen.findByRole("checkbox"));
    await waitFor(() => expect(mocks.update).toHaveBeenCalled());
    expect(mocks.update.mock.calls[0][0]).toEqual({
      marketingEmailsEnabled: true,
      consentSource: "settings",
    });
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith("Nouveautés et offres activées"),
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
    expect(mocks.update.mock.calls[0][0]).toMatchObject({ marketingEmailsEnabled: false });
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith("Nouveautés et offres retirées"),
    );
  });

  it("ne propose rien quand la case n'est pas ouverte à cette personne", async () => {
    mocks.preferences.mockResolvedValue(preferences({ available: false }));
    const { container } = setup();
    await waitFor(() => expect(mocks.preferences).toHaveBeenCalled());
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("garde la case visible pour retirer un consentement quand l'interrupteur est éteint", async () => {
    mocks.preferences.mockResolvedValue(preferences({ enabled: true, available: false }));
    setup();
    expect(((await screen.findByRole("checkbox")) as HTMLInputElement).checked).toBe(true);
  });
});
