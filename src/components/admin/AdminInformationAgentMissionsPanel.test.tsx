// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminInformationAgentMissionsPanel } from "./AdminInformationAgentMissionsPanel";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  action: vi.fn(),
  sourceStatus: vi.fn(),
  sourceRefresh: vi.fn(),
}));

vi.mock("@/lib/client-api", () => ({
  fetchAdminInformationAgentMissions: mocks.list,
  createAdminInformationAgentMission: mocks.create,
  runAdminInformationAgentMissionAction: mocks.action,
  fetchAdminSourceRefreshStatus: mocks.sourceStatus,
  requestAdminSourceRefresh: mocks.sourceRefresh,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("AdminInformationAgentMissionsPanel", () => {
  it("opens the editable draft after one selection and keeps sending explicit", async () => {
    const draft = mission("draft");
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.create.mockResolvedValue({ ok: true, mission: draft, gaps: [], facts: [] });
    mocks.action.mockResolvedValue({ ok: true, missions: [mission("sent")], facts: [] });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderPanel();

    expect(screen.queryByRole("button", { name: "Valider et envoyer" })).toBeNull();
    await screen.findByRole("button", { name: "Valider et envoyer" });
    expect(mocks.create.mock.calls[0][0]).toEqual({
      saleId: "11111111-1111-4111-8111-111111111111",
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

  it("clears the name when the email changes and keeps the edited message explicit", async () => {
    const draft = mission("draft");
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.create.mockResolvedValue({ ok: true, mission: draft, gaps: [], facts: [] });
    mocks.action.mockResolvedValue({ ok: true, missions: [mission("sent")], facts: [] });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderPanel();
    await screen.findByRole("button", { name: "Valider et envoyer" });
    const name = screen.getByRole("textbox", { name: "Nom du destinataire" }) as HTMLInputElement;
    const email = screen.getByRole("textbox", { name: "Email" }) as HTMLInputElement;
    const body = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    const originalBody = body.value;
    expect(name.value).toBe("Maître Dupont");

    fireEvent.change(email, { target: { value: "new-contact@example.test" } });

    expect(name.value).toBe("");
    expect(body.value).toBe(originalBody);
    expect(
      screen.getByRole("heading", { name: "Brouillon pour new-contact@example.test" }),
    ).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "Relisez le nom et la formule d’appel dans le message",
    );
    fireEvent.click(screen.getByRole("button", { name: "Valider et envoyer" }));
    await waitFor(() => expect(mocks.action).toHaveBeenCalledTimes(1));
    expect(mocks.action.mock.calls[0][0]).toMatchObject({
      recipientEmail: "new-contact@example.test",
      recipientName: null,
      bodyText: originalBody,
    });
  });

  it("restores in-session edits after closing and reopening the same draft", async () => {
    const draft = mission("draft");
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.create.mockResolvedValue({ ok: true, mission: draft, gaps: [], facts: [] });
    const selection = {
      saleId: "11111111-1111-4111-8111-111111111111",
      title: "Appartement à Bordeaux",
      recipientName: "Maître Dupont",
      recipientContact: "cabinet@example.test",
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <AdminInformationAgentMissionsPanel selection={selection} onClose={vi.fn()} />
      </QueryClientProvider>,
    );
    await screen.findByRole("button", { name: "Valider et envoyer" });
    fireEvent.change(screen.getByRole("textbox", { name: "Email" }), {
      target: { value: "verified@example.test" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Nom du destinataire" }), {
      target: { value: "Cabinet vérifié" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Objet" }), {
      target: { value: "Objet relu par l’administration" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Message relu et complété manuellement avant envoi." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Fermer" }));
    view.rerender(
      <QueryClientProvider client={client}>
        <AdminInformationAgentMissionsPanel selection={null} onClose={vi.fn()} />
      </QueryClientProvider>,
    );
    view.rerender(
      <QueryClientProvider client={client}>
        <AdminInformationAgentMissionsPanel selection={selection} onClose={vi.fn()} />
      </QueryClientProvider>,
    );

    await screen.findByRole("button", { name: "Valider et envoyer" });
    expect(
      (screen.getByRole("textbox", { name: "Nom du destinataire" }) as HTMLInputElement).value,
    ).toBe("Cabinet vérifié");
    expect((screen.getByRole("textbox", { name: "Email" }) as HTMLInputElement).value).toBe(
      "verified@example.test",
    );
    expect((screen.getByRole("textbox", { name: "Objet" }) as HTMLInputElement).value).toBe(
      "Objet relu par l’administration",
    );
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe(
      "Message relu et complété manuellement avant envoi.",
    );
  });

  it("does not reuse an arbitrary draft when several contacts exist for the sale", async () => {
    const saleId = "11111111-1111-4111-8111-111111111111";
    mocks.list.mockResolvedValue({
      ok: true,
      missions: [
        mission("failed", saleId, "one@example.test"),
        mission("failed", saleId, "two@example.test"),
      ],
      facts: [],
    });
    mocks.create.mockResolvedValue({
      ok: true,
      mission: mission("draft", saleId, "resolved@example.test"),
      gaps: [],
      facts: [],
    });

    renderPanel({
      saleId,
      title: "Appartement à Bordeaux",
      recipientName: null,
      recipientContact: null,
    });

    await screen.findByRole("button", { name: "Valider et envoyer" });
    expect(mocks.create.mock.calls[0][0]).toEqual({ saleId });
  });

  it("keeps sent mission fields read-only", async () => {
    const sent = mission("sent");
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.create.mockResolvedValue({ ok: true, mission: sent, gaps: [], facts: [] });

    renderPanel();
    await screen.findByRole("heading", { name: "Brouillon pour cabinet@example.test" });
    expect(
      (screen.getByRole("textbox", { name: "Nom du destinataire" }) as HTMLInputElement).readOnly,
    ).toBe(true);
    expect((screen.getByRole("textbox", { name: "Email" }) as HTMLInputElement).readOnly).toBe(
      true,
    );
    expect((screen.getByRole("textbox", { name: "Objet" }) as HTMLInputElement).readOnly).toBe(
      true,
    );
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).readOnly).toBe(
      true,
    );
    expect(screen.queryByRole("button", { name: "Valider et envoyer" })).toBeNull();
  });

  it("does not reopen a sent draft from the local preparation cache", async () => {
    const draft = mission("draft");
    const sent = mission("sent");
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.create.mockResolvedValue({ ok: true, mission: draft, gaps: [], facts: [] });
    mocks.action.mockResolvedValue({ ok: true, missions: [sent], facts: [] });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const selection = {
      saleId: "11111111-1111-4111-8111-111111111111",
      title: "Appartement à Bordeaux",
      recipientName: "Maître Dupont",
      recipientContact: "Tél. 01 02 03 · cabinet@example.test",
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <AdminInformationAgentMissionsPanel selection={selection} onClose={vi.fn()} />
      </QueryClientProvider>,
    );
    await screen.findByRole("button", { name: "Valider et envoyer" });
    fireEvent.click(screen.getByRole("button", { name: "Valider et envoyer" }));
    await waitFor(() => expect(mocks.action).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Fermer" }));
    view.rerender(
      <QueryClientProvider client={client}>
        <AdminInformationAgentMissionsPanel selection={null} onClose={vi.fn()} />
      </QueryClientProvider>,
    );
    view.rerender(
      <QueryClientProvider client={client}>
        <AdminInformationAgentMissionsPanel selection={selection} onClose={vi.fn()} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2));
  });

  it("lets an admin resume a mission after a transient send failure", async () => {
    mocks.list.mockResolvedValue({ ok: true, missions: [mission("failed")], facts: [] });

    renderPanel(null);

    fireEvent.click(await screen.findByRole("button", { name: "Reprendre" }));
    expect(screen.getByRole("button", { name: "Valider et envoyer" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Annuler la mission" })).toBeTruthy();
  });

  it("keeps a resumed history mission when a previous queue request finishes late", async () => {
    const firstSaleId = "11111111-1111-4111-8111-111111111111";
    const historyMission = mission(
      "failed",
      "99999999-9999-4999-8999-999999999999",
      "history@example.test",
    );
    let resolveFirst!: (value: unknown) => void;
    const firstResponse = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const onClose = vi.fn();
    mocks.list.mockResolvedValue({ ok: true, missions: [historyMission], facts: [] });
    mocks.sourceStatus.mockResolvedValue({ ok: true, request: null, history: [] });
    mocks.create.mockReturnValue(firstResponse);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AdminInformationAgentMissionsPanel
          selection={{
            saleId: firstSaleId,
            title: "File en cours",
            recipientName: null,
            recipientContact: null,
          }}
          onClose={onClose}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Reprendre" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("heading", { name: "Brouillon pour history@example.test" }),
    ).toBeTruthy();
    resolveFirst({
      ok: true,
      mission: mission("draft", firstSaleId, "late@example.test"),
      gaps: [],
      facts: [],
    });
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Brouillon pour history@example.test" }),
      ).toBeTruthy(),
    );
    expect(screen.queryByRole("heading", { name: "Brouillon pour late@example.test" })).toBeNull();
  });

  it("lets the backend resolve a contact when the selection has no email", async () => {
    const draft = mission("draft");
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.sourceStatus.mockResolvedValue({ ok: true, request: null, history: [] });
    mocks.create.mockResolvedValue({ ok: true, mission: draft, gaps: [], facts: [] });

    renderPanel({
      saleId: "11111111-1111-4111-8111-111111111111",
      title: "Maison à Lille",
      recipientName: "Maître Martin",
      recipientContact: "Téléphone uniquement",
    });

    await screen.findByRole("button", { name: "Valider et envoyer" });
    expect(mocks.create.mock.calls[0][0]).toEqual({
      saleId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("does not trust the first email embedded in a contact label", async () => {
    const draft = mission("draft");
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.sourceStatus.mockResolvedValue({ ok: true, request: null, history: [] });
    mocks.create.mockResolvedValue({ ok: true, mission: draft, gaps: [], facts: [] });

    renderPanel({
      saleId: "11111111-1111-4111-8111-111111111111",
      title: "Maison à Lille",
      recipientName: null,
      recipientContact: "contact@cabinet.example.test",
    });

    await screen.findByRole("button", { name: "Valider et envoyer" });
    expect(mocks.create.mock.calls[0][0]).toEqual({
      saleId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("falls back to a manually confirmed contact after an ambiguous selection", async () => {
    const draft = mission("draft");
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.create
      .mockRejectedValueOnce(new Error("Plusieurs contacts sont possibles."))
      .mockResolvedValueOnce({ ok: true, mission: draft, gaps: [], facts: [] });
    mocks.sourceStatus.mockResolvedValue({ ok: true, request: null, history: [] });

    renderPanel({
      saleId: "11111111-1111-4111-8111-111111111111",
      title: "Maison à Lille",
      recipientName: "Contact à vérifier",
      recipientContact: "cabinet-a@example.test · cabinet-b@example.test",
    });

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Plusieurs contacts sont possibles",
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Nom du destinataire (à vérifier)" }), {
      target: { value: "Cabinet A" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Email du destinataire" }), {
      target: { value: "cabinet-a@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Préparer avec ce contact" }));

    await screen.findByRole("button", { name: "Valider et envoyer" });
    expect(mocks.create.mock.calls[0][0]).toEqual({
      saleId: "11111111-1111-4111-8111-111111111111",
    });
    expect(mocks.create.mock.calls[1][0]).toEqual({
      saleId: "11111111-1111-4111-8111-111111111111",
      recipientEmail: "cabinet-a@example.test",
      recipientName: "Cabinet A",
    });
  });

  it("queues a refresh for the exact sale and exposes its running status", async () => {
    mocks.create.mockResolvedValue({ ok: true, mission: mission("draft"), gaps: [], facts: [] });
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.sourceRefresh.mockResolvedValue({
      ok: true,
      saleId: "11111111-1111-4111-8111-111111111111",
      request: {
        id: "55555555-5555-4555-8555-555555555555",
        saleId: "11111111-1111-4111-8111-111111111111",
        kind: "source_detail",
        status: "queued",
        priority: 85,
        reused: false,
        requestedAt: "2026-09-28T10:00:00.000Z",
        startedAt: null,
        completedAt: null,
        errorMessage: null,
      },
      history: [],
    });

    renderPanel();

    await screen.findByRole("button", { name: "Valider et envoyer" });
    fireEvent.click(await screen.findByRole("button", { name: "Actualiser la source" }));
    await waitFor(() =>
      expect(mocks.sourceRefresh.mock.calls[0]?.[0]).toEqual({
        saleId: "11111111-1111-4111-8111-111111111111",
        force: true,
      }),
    );
    expect(await screen.findByText("en file")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Refresh en cours…" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("does not label an older completed refresh as this draft's refresh", async () => {
    mocks.create.mockResolvedValue({ ok: true, mission: mission("draft"), gaps: [], facts: [] });
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });

    renderPanel(undefined, {
      ok: true,
      saleId: "11111111-1111-4111-8111-111111111111",
      request: {
        id: "55555555-5555-4555-8555-555555555555",
        saleId: "11111111-1111-4111-8111-111111111111",
        kind: "source_detail",
        status: "completed",
        priority: 120,
        reused: false,
        requestedAt: "2026-09-28T10:00:00.000Z",
        startedAt: "2026-09-28T10:01:00.000Z",
        completedAt: "2026-09-28T10:02:00.000Z",
        errorMessage: null,
      },
      history: [],
    });

    await screen.findByRole("button", { name: "Valider et envoyer" });
    expect(screen.getByRole("button", { name: "Actualiser la source" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Régénérer depuis la source actualisée" }),
    ).toBeNull();
  });

  it("ignores a stale draft response after the admin changes the selection", async () => {
    const firstSaleId = "11111111-1111-4111-8111-111111111111";
    const secondSaleId = "99999999-9999-4999-8999-999999999999";
    let resolveFirst!: (value: unknown) => void;
    const firstResponse = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    mocks.list.mockResolvedValue({ ok: true, missions: [], facts: [] });
    mocks.create.mockImplementation(({ saleId }: { saleId: string }) =>
      saleId === firstSaleId
        ? firstResponse
        : Promise.resolve({
            ok: true,
            mission: mission("draft", secondSaleId, "second@example.test"),
            gaps: [],
            facts: [],
          }),
    );

    const firstSelection = {
      saleId: firstSaleId,
      title: "Première annonce",
      recipientName: null,
      recipientContact: null,
    };
    const secondSelection = {
      saleId: secondSaleId,
      title: "Seconde annonce",
      recipientName: null,
      recipientContact: null,
    };
    mocks.sourceStatus.mockResolvedValue({ ok: true, request: null, history: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <AdminInformationAgentMissionsPanel selection={firstSelection} onClose={vi.fn()} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(mocks.create.mock.calls[0]?.[0]).toEqual({ saleId: firstSaleId }));
    view.rerender(
      <QueryClientProvider client={client}>
        <AdminInformationAgentMissionsPanel selection={secondSelection} onClose={vi.fn()} />
      </QueryClientProvider>,
    );
    await screen.findByRole("button", { name: "Valider et envoyer" });
    expect(
      screen.getByRole("heading", { name: "Brouillon pour second@example.test" }),
    ).toBeTruthy();

    resolveFirst({
      ok: true,
      mission: mission("draft", firstSaleId, "first@example.test"),
      gaps: [],
      facts: [],
    });
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Brouillon pour second@example.test" }),
      ).toBeTruthy(),
    );
    expect(screen.queryByRole("heading", { name: "Brouillon pour first@example.test" })).toBeNull();
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

    renderPanel(null);

    expect(await screen.findByText("page0@example.test")).toBeTruthy();
    expect(mocks.list).toHaveBeenLastCalledWith({ offset: 0, limit: 50 });
    expect(screen.getByText(/1–1 sur 120 · page 1 sur 3/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Suivant — missions récentes" }));
    expect(await screen.findByText("page50@example.test")).toBeTruthy();
    expect(mocks.list).toHaveBeenLastCalledWith({ offset: 50, limit: 50 });
    fireEvent.click(screen.getByRole("button", { name: "Précédent — missions récentes" }));
    expect(await screen.findByText("page0@example.test")).toBeTruthy();
  });

  it("looks up the sale's own drafts before creating one when the history has more pages", async () => {
    const saleId = "11111111-1111-4111-8111-111111111111";
    const existing = { ...mission("draft", saleId, "existing@example.test"), id: "old-draft" };
    mocks.list.mockImplementation(async (args: { saleId?: string; offset?: number }) =>
      args.saleId
        ? {
            ok: true,
            missions: [existing],
            facts: [],
            offset: 0,
            limit: 100,
            total: 1,
            hasMore: false,
          }
        : {
            ok: true,
            missions: [{ ...mission("sent"), id: "recent", saleId: "other-sale" }],
            facts: [],
            offset: 0,
            limit: 50,
            total: 80,
            hasMore: true,
          },
    );
    mocks.create.mockResolvedValue({ ok: true, mission: mission("draft"), gaps: [], facts: [] });

    renderPanel({
      saleId,
      title: "Appartement à Bordeaux",
      recipientName: null,
      recipientContact: null,
    });

    expect(
      await screen.findByRole("heading", { name: "Brouillon pour existing@example.test" }),
    ).toBeTruthy();
    expect(mocks.list).toHaveBeenCalledWith({ saleId, limit: 100 });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("creates the draft when the sale has none even though the history has more pages", async () => {
    const saleId = "11111111-1111-4111-8111-111111111111";
    mocks.list.mockImplementation(async (args: { saleId?: string }) =>
      args.saleId
        ? { ok: true, missions: [], facts: [], offset: 0, limit: 100, total: 0, hasMore: false }
        : {
            ok: true,
            missions: [{ ...mission("sent"), id: "recent", saleId: "other-sale" }],
            facts: [],
            offset: 0,
            limit: 50,
            total: 80,
            hasMore: true,
          },
    );
    mocks.create.mockResolvedValue({
      ok: true,
      mission: mission("draft", saleId, "created@example.test"),
      gaps: [],
      facts: [],
    });

    renderPanel({
      saleId,
      title: "Appartement à Bordeaux",
      recipientName: null,
      recipientContact: null,
    });

    expect(
      await screen.findByRole("heading", { name: "Brouillon pour created@example.test" }),
    ).toBeTruthy();
    expect(mocks.create).toHaveBeenCalledTimes(1);
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
  sourceStatus: unknown = { ok: true, request: null, history: [] },
) {
  mocks.sourceStatus.mockResolvedValue(sourceStatus);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AdminInformationAgentMissionsPanel selection={selection} onClose={vi.fn()} />
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
    approvedAt: status === "sent" ? "2026-09-19T10:00:00.000Z" : null,
    sentAt: status === "sent" ? "2026-09-19T10:01:00.000Z" : null,
    repliedAt: null,
    createdAt: "2026-09-19T09:00:00.000Z",
    updatedAt: "2026-09-19T10:01:00.000Z",
  };
}
