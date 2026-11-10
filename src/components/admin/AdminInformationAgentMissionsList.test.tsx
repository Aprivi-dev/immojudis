// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminInformationAgentMissionsList } from "./AdminInformationAgentMissionsList";

const mocks = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("@/lib/client-api", () => ({ fetchAdminInformationAgentMissions: mocks.list }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("AdminInformationAgentMissionsList (onglet Envois)", () => {
  it("shows the sale title as a link to the fiche on every history row", async () => {
    mocks.list.mockResolvedValue({
      ok: true,
      missions: [
        { ...mission("sent"), saleTitle: "Appartement à Bordeaux" },
        {
          ...mission("draft", "55555555-5555-4555-8555-555555555555", "autre@example.test"),
          id: "66666666-6666-4666-8666-666666666666",
          saleTitle: null,
        },
      ],
      facts: [],
    });

    renderList();

    const titled = await screen.findByRole("link", { name: "Appartement à Bordeaux" });
    expect(titled.getAttribute("href")).toBe("/sales/11111111-1111-4111-8111-111111111111");
    const untitled = screen.getByRole("link", { name: "Annonce sans titre" });
    expect(untitled.getAttribute("href")).toBe("/sales/55555555-5555-4555-8555-555555555555");
    expect(screen.getByText("cabinet@example.test")).toBeTruthy();
    expect(screen.getByText("autre@example.test")).toBeTruthy();
  });

  it("keeps Reprendre for a draft and Ouvrir for the other statuses", async () => {
    mocks.list.mockResolvedValue({
      ok: true,
      missions: [
        mission("draft"),
        {
          ...mission("sent", "11111111-1111-4111-8111-111111111111", "b@example.test"),
          id: "77777777-7777-4777-8777-777777777777",
          status: "replied",
        },
      ],
      facts: [],
    });

    renderList();

    expect(await screen.findAllByRole("button", { name: "Reprendre" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Ouvrir" })).toHaveLength(1);
  });

  it("pages the history 50 missions at a time with offset/limit and the exact total", async () => {
    mocks.list.mockImplementation(async ({ offset }: { offset: number }) => ({
      ok: true,
      missions: [
        {
          ...mission("sent"),
          id: `mission-${offset}`,
          recipientEmail: `page${offset}@example.test`,
        },
      ],
      facts: [],
      offset,
      limit: 50,
      total: 120,
      hasMore: offset + 50 < 120,
    }));

    renderList();

    expect(await screen.findByText("page0@example.test")).toBeTruthy();
    expect(mocks.list).toHaveBeenLastCalledWith({ offset: 0, limit: 50 });
    expect(screen.getByText(/1–1 sur 120 · page 1 sur 3/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Suivant — missions récentes" }));
    expect(await screen.findByText("page50@example.test")).toBeTruthy();
    expect(mocks.list).toHaveBeenLastCalledWith({ offset: 50, limit: 50 });
    fireEvent.click(screen.getByRole("button", { name: "Précédent — missions récentes" }));
    expect(await screen.findByText("page0@example.test")).toBeTruthy();
  });

  it("rend la main à l'éditeur avec la mission choisie", async () => {
    const onOpenMission = vi.fn();
    mocks.list.mockResolvedValue({ ok: true, missions: [mission("draft")], facts: [] });

    renderList(onOpenMission);
    fireEvent.click(await screen.findByRole("button", { name: "Reprendre" }));

    expect(onOpenMission).toHaveBeenCalledTimes(1);
    expect(onOpenMission.mock.calls[0][0]).toMatchObject({
      id: "22222222-2222-4222-8222-222222222222",
      status: "draft",
    });
  });

  it("indique l'état de chaque mission : brouillon, envoyée, réponse reçue, échec", async () => {
    mocks.list.mockResolvedValue({
      ok: true,
      missions: ["draft", "sent", "replied", "failed"].map((status, index) => ({
        ...mission("draft"),
        id: `mission-${index}`,
        status,
        recipientEmail: `etat${index}@example.test`,
      })),
      facts: [],
    });

    renderList();

    expect(await screen.findByText(/^Brouillon ·/)).toBeTruthy();
    expect(screen.getByText(/^Envoyée ·/)).toBeTruthy();
    expect(screen.getByText(/^Réponse reçue ·/)).toBeTruthy();
    expect(screen.getByText(/^Échec ·/)).toBeTruthy();
  });

  it("affiche l'état de remise en texte à côté de l'état de la mission, rien sans information", async () => {
    const states = [
      "delivered",
      "bounced",
      "bounced_temporary",
      "complained",
      "delayed",
      null,
      undefined,
    ];
    mocks.list.mockResolvedValue({
      ok: true,
      missions: states.map((deliveryState, index) => ({
        ...mission("sent"),
        id: `mission-${index}`,
        recipientEmail: `remise${index}@example.test`,
        deliveryState,
      })),
      facts: [],
    });

    renderList();

    const remis = await screen.findByText("Remis");
    expect(remis.className).toContain("text-success");
    expect(remis.closest("p")?.textContent).toMatch(/^Envoyée · Remis · /);
    expect(screen.getByText("Rebond").className).toContain("text-danger");
    expect(screen.getByText("Rebond passager").className).toContain("text-warning");
    expect(
      screen.getByText(
        "Rebond passager : souvent une réponse automatique d’absence ; l’adresse reste utilisable",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Plainte").className).toContain("text-danger");
    expect(screen.getByText("Différé")).toBeTruthy();
    // Sans information : l'état de la mission et la date seulement.
    const lines = screen.getAllByText(/^Envoyée ·/).map((line) => line.textContent ?? "");
    expect(lines.filter((line) => /^Envoyée · \d/.test(line))).toHaveLength(2);
  });
});

function renderList(onOpenMission: (mission: unknown) => void = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AdminInformationAgentMissionsList onOpenMission={onOpenMission} />
    </QueryClientProvider>,
  );
}

function mission(
  status: "draft" | "sent" | "failed",
  saleId = "11111111-1111-4111-8111-111111111111",
  recipientEmail = "cabinet@example.test",
) {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    caseId: "33333333-3333-4333-8333-333333333333",
    saleId,
    status,
    recipientKind: "source_lawyer",
    recipientName: "Maître Dupont",
    recipientEmail,
    subject: "Demande de pièces",
    bodyText: "Bonjour, pourriez-vous transmettre les pièces complémentaires du dossier ?",
    questionKeys: ["documents"],
    missingInformation: ["documents"],
    failureReason: null,
    approvedAt: null,
    sentAt: null,
    repliedAt: null,
    createdAt: "2026-09-19T09:00:00.000Z",
    updatedAt: "2026-09-19T10:01:00.000Z",
  };
}
