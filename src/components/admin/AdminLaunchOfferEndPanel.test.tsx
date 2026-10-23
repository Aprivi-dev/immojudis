// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaunchOfferEndState } from "@/lib/admin-launch-offer-end";

const mocks = vi.hoisted(() => ({
  fetchState: vi.fn(),
  post: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/client-api/admin-launch-offer-end", () => ({
  fetchAdminLaunchOfferEnd: mocks.fetchState,
  postAdminLaunchOfferEnd: mocks.post,
}));
vi.mock("@/lib/toast", () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock("@/components/admin/AdminShell", () => ({
  AdminPanel: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}));

import { AdminLaunchOfferEndPanel } from "./AdminLaunchOfferEndPanel";

function state(overrides: Partial<LaunchOfferEndState> = {}): LaunchOfferEndState {
  return {
    active: true,
    endsOn: "2026-12-01",
    endsOnLabel: "1 décembre 2026",
    daysLeft: 39,
    minNoticeDays: 30,
    blocker: null,
    audience: {
      accounts: 12,
      optedOut: 1,
      notified: 2,
      recipients: 9,
      inProgress: 0,
      needsReview: 0,
    },
    batchSize: 200,
    configured: true,
    missing: [],
    preview: {
      subject: "Immojudis : fin de l’offre de lancement prévue le 1 décembre 2026",
      text: "Corps",
    },
    ...overrides,
  };
}

function renderPanel() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
    >
      <AdminLaunchOfferEndPanel />
    </QueryClientProvider>,
  );
}

describe("AdminLaunchOfferEndPanel", () => {
  beforeEach(() => {
    mocks.fetchState.mockResolvedValue(state());
    vi.spyOn(window, "confirm").mockImplementation(() => true);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  it("montre la date, les comptes concernés et l'aperçu, sans rien envoyer à l'ouverture", async () => {
    renderPanel();

    expect((await screen.findByTestId("launch-offer-end-status")).textContent).toContain(
      "Fin annoncée le 1 décembre 2026 (dans 39 jours)",
    );
    expect(screen.getByTestId("launch-offer-end-audience").textContent).toMatch(
      /9\s+comptes à prévenir sur 12.*2 déjà prévenus, 1 désinscrit/,
    );
    expect(screen.getByText("Aperçu du message")).toBeTruthy();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("n'envoie qu'après la confirmation, avec la date affichée", async () => {
    mocks.post.mockResolvedValue({
      sent: 9,
      failed: 0,
      skipped: 0,
      remaining: 0,
      stoppedEarly: false,
    });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Envoyer le préavis à 9 comptes" }));

    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith({
        action: "send",
        endsOn: "2026-12-01",
        confirm: true,
      }),
    );
    expect(window.confirm).toHaveBeenCalledOnce();
  });

  it("n'envoie rien quand l'administrateur refuse la confirmation", async () => {
    vi.spyOn(window, "confirm").mockImplementation(() => false);
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Envoyer le préavis à 9 comptes" }));

    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("désactive l'envoi quand le préavis est trop court, sans destinataire ou non configuré", async () => {
    mocks.fetchState.mockResolvedValue(
      state({
        blocker: "La date de fin est dans 12 jours : le préavis doit être d’au moins 30 jours.",
      }),
    );
    renderPanel();

    const button = (await screen.findByRole("button", {
      name: "Envoyer le préavis à 9 comptes",
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByTestId("launch-offer-end-status").textContent).toContain(
      "au moins 30 jours",
    );
    cleanup();

    mocks.fetchState.mockResolvedValue(state({ configured: false, missing: ["RESEND_API_KEY"] }));
    renderPanel();
    expect(
      ((await screen.findByRole("button", { name: "M’envoyer un essai" })) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText(/manque : RESEND_API_KEY/)).toBeTruthy();
  });

  it("enregistre la date annoncée sans rien envoyer, et le dit : l'offre reste active", async () => {
    mocks.fetchState.mockResolvedValue(
      state({
        endsOn: null,
        endsOnLabel: null,
        daysLeft: null,
        audience: null,
        preview: null,
        blocker: "Enregistrez d’abord la date de fin annoncée.",
      }),
    );
    mocks.post.mockResolvedValue(state());
    renderPanel();

    const input = (await screen.findByLabelText("Date de fin annoncée")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "2026-12-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer la date" }));

    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith({ action: "set-date", endsOn: "2026-12-01" }),
    );
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith(expect.stringContaining("L’offre reste active")),
    );
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });

  it("signale les envois à vérifier et dit quand le service n'est pas disponible", async () => {
    mocks.fetchState.mockResolvedValue(
      state({
        audience: {
          accounts: 3,
          optedOut: 0,
          notified: 0,
          recipients: 0,
          inProgress: 0,
          needsReview: 2,
        },
      }),
    );
    renderPanel();
    expect((await screen.findByRole("status")).textContent).toContain("2 envois à vérifier");
    cleanup();

    mocks.fetchState.mockRejectedValue(
      new Error("La migration 20261102140000 n’est pas appliquée."),
    );
    renderPanel();
    expect((await screen.findByRole("alert")).textContent).toContain("migration 20261102140000");
  });
});
