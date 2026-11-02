// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminInformationAgentOperationsPanel } from "./AdminInformationAgentOperationsPanel";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), attest: vi.fn() }));

vi.mock("@/lib/client-api", () => ({
  fetchAdminInformationAgentOperations: mocks.fetch,
  attestAdminInformationAgentRoundtripClient: mocks.attest,
}));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const view = (label: string, stale: boolean) => ({
  windowLabel: "30 derniers jours",
  sent: 12,
  rows: [
    { key: "sent", label: "Envoyés", value: "12", tone: "plain" },
    { key: "delivered", label: "Remis", value: "10 sur 12 (83,3 %)", tone: "ok" },
  ],
  roundtrip: { verifiedAt: null, label, stale },
});

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AdminInformationAgentOperationsPanel />
    </QueryClientProvider>,
  );
}

describe("AdminInformationAgentOperationsPanel", () => {
  it("affiche les indicateurs tels que le serveur les met en forme, avec leur effectif", async () => {
    mocks.fetch.mockResolvedValue(view("Jamais vérifié.", true));
    renderPanel();

    expect(await screen.findByText("10 sur 12 (83,3 %)")).toBeTruthy();
    expect(screen.getByText("30 derniers jours")).toBeTruthy();
    expect(screen.getByText(/Aller-retour de réception : Jamais vérifié/)).toBeTruthy();
  });

  it("enregistre la vérification de l'aller-retour en un clic", async () => {
    mocks.fetch.mockResolvedValue(view("Jamais vérifié.", true));
    mocks.attest.mockResolvedValue(view("Vérifié aujourd’hui.", false));
    renderPanel();

    fireEvent.click(
      await screen.findByRole("button", { name: "J’ai vérifié l’aller-retour réel" }),
    );

    await waitFor(() => expect(mocks.attest).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Vérifié aujourd’hui/)).toBeTruthy();
  });

  it("dit que les indicateurs sont indisponibles plutôt que d'afficher des zéros", async () => {
    mocks.fetch.mockRejectedValue(new Error("boom"));
    renderPanel();
    expect((await screen.findByRole("alert")).textContent).toContain("indisponibles");
  });
});
