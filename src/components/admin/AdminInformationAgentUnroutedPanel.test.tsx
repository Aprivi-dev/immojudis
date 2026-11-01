// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminInformationAgentUnroutedPanel } from "./AdminInformationAgentUnroutedPanel";

const mocks = vi.hoisted(() => ({ fetchUnrouted: vi.fn(), markHandled: vi.fn() }));

vi.mock("@/lib/client-api", () => ({
  fetchAdminInformationAgentUnrouted: mocks.fetchUnrouted,
  markAdminInformationAgentUnroutedHandledClient: mocks.markHandled,
}));

const MESSAGE_ID = "55555555-5555-4555-8555-555555555555";

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: MESSAGE_ID,
    provider_email_id: "provider-email-1",
    sender: "Maître Dupont <maitre@example.test>",
    sender_email: "maitre@example.test",
    subject: "Re: Vente du 12 décembre",
    received_at: "2026-12-01T09:00:00.000Z",
    excerpt: "Bonjour, la vente est reportée.",
    reason: "case_not_open",
    sender_known: true,
    sender_authentication: "pass",
    attachment_count: 0,
    opposition_recorded: false,
    created_at: "2026-12-01T09:00:01.000Z",
    ...overrides,
  };
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AdminInformationAgentUnroutedPanel />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("AdminInformationAgentUnroutedPanel", () => {
  it("affiche l'expéditeur, l'objet, le motif et l'extrait d'un message non rattaché", async () => {
    mocks.fetchUnrouted.mockResolvedValue({
      messages: [message({ attachment_count: 2 })],
      offset: 0,
      limit: 50,
      total: 1,
      hasMore: false,
    });
    renderPanel();

    expect(await screen.findByText("Maître Dupont <maitre@example.test>")).toBeTruthy();
    expect(screen.getByText("Re: Vente du 12 décembre")).toBeTruthy();
    expect(screen.getByText(/Dossier clos/)).toBeTruthy();
    expect(screen.getByText(/2 pièce\(s\) jointe\(s\) non conservée\(s\)/)).toBeTruthy();
    expect(screen.getByText("Bonjour, la vente est reportée.")).toBeTruthy();
  });

  it("montre le texte d'un message HTML comme du texte, sans l'interpréter", async () => {
    mocks.fetchUnrouted.mockResolvedValue({
      messages: [message({ excerpt: "<img src=x onerror=alert(1)> cliquez ici" })],
      offset: 0,
      limit: 50,
      total: 1,
      hasMore: false,
    });
    renderPanel();

    expect(await screen.findByText("<img src=x onerror=alert(1)> cliquez ici")).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
  });

  it("indique qu'un expéditeur inconnu n'a pas été lu et renvoie vers Resend", async () => {
    mocks.fetchUnrouted.mockResolvedValue({
      messages: [message({ excerpt: null, sender_known: false, sender_authentication: null })],
      offset: 0,
      limit: 50,
      total: 1,
      hasMore: false,
    });
    renderPanel();

    expect(await screen.findByText(/Texte non lu : expéditeur inconnu/)).toBeTruthy();
    expect(screen.getByText(/provider-email-1/)).toBeTruthy();
  });

  it("marque un message comme traité", async () => {
    mocks.fetchUnrouted.mockResolvedValue({
      messages: [message()],
      offset: 0,
      limit: 50,
      total: 1,
      hasMore: false,
    });
    mocks.markHandled.mockResolvedValue({ ok: true });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: /Marquer comme traité/ }));

    await waitFor(() =>
      expect(mocks.markHandled).toHaveBeenCalledWith(
        { action: "mark_handled", messageId: MESSAGE_ID },
        expect.anything(),
      ),
    );
  });

  it("annonce l'absence de message à traiter", async () => {
    mocks.fetchUnrouted.mockResolvedValue({
      messages: [],
      offset: 0,
      limit: 50,
      total: 0,
      hasMore: false,
    });
    renderPanel();

    expect(await screen.findByText("Aucun message non rattaché à traiter.")).toBeTruthy();
  });
});
