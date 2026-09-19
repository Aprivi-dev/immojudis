// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminInformationAgentMissionsPanel } from "./AdminInformationAgentMissionsPanel";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  action: vi.fn(),
}));

vi.mock("@/lib/client-api", () => ({
  fetchAdminInformationAgentMissions: mocks.list,
  createAdminInformationAgentMission: mocks.create,
  runAdminInformationAgentMissionAction: mocks.action,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("AdminInformationAgentMissionsPanel", () => {
  it("keeps generation and sending as two explicit admin actions", async () => {
    const draft = mission("draft");
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.create.mockResolvedValue({ ok: true, mission: draft, gaps: [], facts: [] });
    mocks.action.mockResolvedValue({ ok: true, missions: [mission("sent")], facts: [] });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderPanel();

    expect(screen.queryByRole("button", { name: "Valider et envoyer" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Générer le brouillon" }));

    await screen.findByRole("button", { name: "Valider et envoyer" });
    expect(mocks.create.mock.calls[0][0]).toEqual({
      saleId: "11111111-1111-4111-8111-111111111111",
      recipientEmail: "cabinet@example.test",
      recipientName: "Maître Dupont",
    });

    fireEvent.click(screen.getByRole("button", { name: "Valider et envoyer" }));
    await waitFor(() => expect(mocks.action).toHaveBeenCalledTimes(1));
    expect(mocks.action.mock.calls[0][0]).toMatchObject({
      action: "approve_and_send",
      approvalConfirmed: true,
      recipientEmail: "cabinet@example.test",
    });
    expect(mocks.action.mock.calls[0][0]).not.toHaveProperty("shareRequesterEmail");
  });

  it("lets an admin resume a mission after a transient send failure", async () => {
    mocks.list.mockResolvedValue({ ok: true, missions: [mission("failed")], facts: [] });

    renderPanel(null);

    fireEvent.click(await screen.findByRole("button", { name: "Reprendre" }));
    expect(screen.getByRole("button", { name: "Valider et envoyer" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Annuler la mission" })).toBeTruthy();
  });
});

function renderPanel(
  selection: {
    saleId: string;
    title: string;
    recipientName: string | null;
    recipientContact: string | null;
  } | null = {
    saleId: "11111111-1111-4111-8111-111111111111",
    title: "Appartement à Bordeaux",
    recipientName: "Maître Dupont",
    recipientContact: "Tél. 01 02 03 · cabinet@example.test",
  },
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AdminInformationAgentMissionsPanel selection={selection} onClose={vi.fn()} />
    </QueryClientProvider>,
  );
}

function mission(status: "draft" | "sent" | "failed") {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    caseId: "33333333-3333-4333-8333-333333333333",
    saleId: "11111111-1111-4111-8111-111111111111",
    status,
    recipientKind: "source_lawyer",
    recipientName: "Maître Dupont",
    recipientEmail: "cabinet@example.test",
    subject: "Demande de pièces",
    bodyText: "Bonjour, pourriez-vous transmettre les pièces complémentaires du dossier ?",
    questionKeys: ["documents"],
    missingInformation: ["documents"],
    failureReason: null,
    approvedAt: status === "sent" ? "2026-09-19T10:00:00.000Z" : null,
    sentAt: status === "sent" ? "2026-09-19T10:01:00.000Z" : null,
    repliedAt: null,
    createdAt: "2026-09-19T09:00:00.000Z",
    updatedAt: "2026-09-19T10:01:00.000Z",
  };
}
