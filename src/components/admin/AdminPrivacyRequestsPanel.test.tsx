// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrivacyRequestAdminSummary } from "@/lib/privacy-requests";
import { AdminPrivacyRequestsPanel } from "./AdminPrivacyRequestsPanel";

const mocks = vi.hoisted(() => ({
  fetchRequests: vi.fn(),
  withdraw: vi.fn(),
  erase: vi.fn(),
  update: vi.fn(),
  guard: vi.fn(),
  withdrawalContext: vi.fn(),
  accountExport: vi.fn(),
}));

vi.mock("@/lib/client-api", () => ({
  executeAdminContractWithdrawal: mocks.withdraw,
  executeAdminPrivacyErasure: mocks.erase,
  fetchAdminPrivacyRequests: mocks.fetchRequests,
  fetchAdminProfessionalPrivacyExport: vi.fn(),
  fetchAdminAccountPrivacyExport: mocks.accountExport,
  fetchAdminContractWithdrawalContext: mocks.withdrawalContext,
  fetchAdminErasureGuard: mocks.guard,
  updateAdminPrivacyRequest: mocks.update,
}));
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

const REQUEST_ID = "76000000-0000-4000-8000-000000000103";
const WITHDRAWAL: PrivacyRequestAdminSummary = {
  id: REQUEST_ID,
  requestType: "contract_withdrawal",
  status: "received",
  identityStatus: "authenticated",
  requesterEmail: "client@example.test",
  userId: "76000000-0000-4000-8000-000000000001",
  subjectKind: "account",
  message: null,
  submittedAt: "2026-11-10T08:00:00.000Z",
  acknowledgedAt: "2026-11-10T08:00:00.000Z",
  dueAt: "2026-12-10T08:00:00.000Z",
  completedAt: null,
  resolutionCode: null,
  operatorNotes: null,
  deadline: { daysRemaining: 26, overdue: false, dueSoon: false },
  withdrawalPurchaseId: null,
  notifications: { operator: "sent", acknowledgement: "sent", closure: null },
  closureResponse: null,
};

function list(requests: PrivacyRequestAdminSummary[]) {
  return {
    requests,
    total: requests.length,
    openCount: requests.length,
    overdueCount: 0,
    truncated: false,
    offset: 0,
    limit: 100,
    hasMore: false,
  };
}

function renderPanel() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <AdminPrivacyRequestsPanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.fetchRequests.mockResolvedValue({
    requests: [WITHDRAWAL],
    total: 1,
    openCount: 1,
    overdueCount: 0,
    truncated: false,
    offset: 0,
    limit: 100,
    hasMore: false,
  });
  mocks.withdraw.mockResolvedValue({ refundedCents: 1200, subscriptionCancelled: true });
  mocks.withdrawalContext.mockResolvedValue({
    target: "subscription",
    hasStripeSubscription: true,
  });
  mocks.guard.mockResolvedValue({ reasons: [], requiresConfirmation: false });
  mocks.erase.mockResolvedValue({});
  mocks.update.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AdminPrivacyRequestsPanel : rétractation", () => {
  it("n'envoie la rétractation, avec sa confirmation, qu'après « Confirmer »", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AdminPrivacyRequestsPanel />
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Résilier et rembourser" }));
    expect(mocks.withdraw).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirmer : résilier et rembourser" }));

    await waitFor(() => expect(mocks.withdraw).toHaveBeenCalledTimes(1));
    expect(mocks.withdraw.mock.calls[0][0]).toEqual({
      requestId: REQUEST_ID,
      refundMode: "prorata",
      confirm: true,
    });
  });
});

describe("AdminPrivacyRequestsPanel : effacement d'un professionnel", () => {
  it("demande de traiter d'abord les « Retraits à faire » de l'adresse (lot C)", async () => {
    mocks.fetchRequests.mockResolvedValue({
      requests: [
        {
          ...WITHDRAWAL,
          requestType: "erasure",
          identityStatus: "verified",
          requesterEmail: "avocat@cabinet.example",
          userId: null,
          subjectKind: "information_agent_professional",
        },
      ],
      total: 1,
      openCount: 1,
      overdueCount: 0,
      truncated: false,
      offset: 0,
      limit: 100,
      hasMore: false,
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AdminPrivacyRequestsPanel />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByText(
        /Traitez d'abord les « Retraits à faire » de cette adresse : après l'effacement, les valeurs affichées ne peuvent plus être listées\./,
      ),
    ).toBeTruthy();
  });
});

describe("AdminPrivacyRequestsPanel : rétractation d'un achat à l'unité (M4)", () => {
  it("montre les faits de l'achat et rembourse intégralement après confirmation", async () => {
    mocks.fetchRequests.mockResolvedValue(
      list([{ ...WITHDRAWAL, withdrawalPurchaseId: "76000000-0000-4000-8000-000000000201" }]),
    );
    mocks.withdrawalContext.mockResolvedValue({
      target: "sale_unlock_purchase",
      purchase: {
        id: "76000000-0000-4000-8000-000000000201",
        state: "paid",
        paidAt: "2026-11-12T08:00:00.000Z",
        amountCents: 1900,
        currency: "eur",
        withinWithdrawalPeriod: true,
        accessProvided: true,
        deducted: false,
        waiverAcknowledged: true,
        confirmationSent: true,
      },
    });
    renderPanel();

    expect(
      await screen.findByText(/Accès fourni \(vente ouverte avec cet achat\) : oui/),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Mode de remboursement")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Rembourser l’achat" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmer : rembourser l’achat" }));
    await waitFor(() => expect(mocks.withdraw).toHaveBeenCalledTimes(1));
    expect(mocks.withdraw.mock.calls[0][0]).toEqual({
      requestId: REQUEST_ID,
      refundMode: "full",
      confirm: true,
    });
  });
  it("signale un achat déduit du premier mois d'un abonnement", async () => {
    mocks.fetchRequests.mockResolvedValue(
      list([{ ...WITHDRAWAL, withdrawalPurchaseId: "76000000-0000-4000-8000-000000000201" }]),
    );
    mocks.withdrawalContext.mockResolvedValue({
      target: "sale_unlock_purchase",
      purchase: {
        id: "76000000-0000-4000-8000-000000000201",
        state: "paid",
        paidAt: "2026-11-12T08:00:00.000Z",
        amountCents: 1900,
        currency: "eur",
        withinWithdrawalPeriod: true,
        accessProvided: false,
        deducted: true,
        waiverAcknowledged: true,
        confirmationSent: true,
      },
    });
    renderPanel();

    expect(
      await screen.findByText(
        /Déduit du premier mois d’un abonnement : oui\. Plus remboursable seul/,
      ),
    ).toBeTruthy();
  });
});

describe("AdminPrivacyRequestsPanel : garde avant effacement (M2)", () => {
  const ERASURE: PrivacyRequestAdminSummary = {
    ...WITHDRAWAL,
    requestType: "erasure",
    identityStatus: "verified",
  };

  it("exige la case de confirmation et l'envoie au serveur", async () => {
    mocks.fetchRequests.mockResolvedValue(list([ERASURE]));
    mocks.guard.mockResolvedValue({
      reasons: ["Abonnement Analyse actif (période payée jusqu'au 1 décembre 2026)."],
      requiresConfirmation: true,
    });
    renderPanel();

    expect(await screen.findByText(/Abonnement Analyse actif/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Email du demandeur pour confirmer l'effacement"), {
      target: { value: "client@example.test" },
    });
    const button = screen.getByRole("button", { name: "Exécuter l'effacement" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Je confirme l'effacement malgré ces éléments."));
    fireEvent.click(button);
    await waitFor(() => expect(mocks.erase).toHaveBeenCalledTimes(1));
    expect(mocks.erase.mock.calls[0][0]).toEqual({
      requestId: REQUEST_ID,
      confirmEmail: "client@example.test",
      confirmFinancialImpact: true,
    });
  });
});

describe("AdminPrivacyRequestsPanel : export d'un titulaire de compte (M3) et refus motivé", () => {
  it("propose l'export JSON pour une demande d'accès d'un compte", async () => {
    mocks.fetchRequests.mockResolvedValue(list([{ ...WITHDRAWAL, requestType: "access" }]));
    mocks.accountExport.mockResolvedValue({ generatedAt: "2026-11-16T08:00:00.000Z" });
    URL.createObjectURL = vi.fn(() => "blob:export");
    URL.revokeObjectURL = vi.fn();
    renderPanel();

    fireEvent.click(
      await screen.findByRole("button", { name: "Télécharger les données du compte (JSON)" }),
    );
    await waitFor(() => expect(mocks.accountExport).toHaveBeenCalledTimes(1));
    expect(mocks.accountExport.mock.calls[0][0]).toBe(REQUEST_ID);
  });

  it("n'enregistre pas un refus sans réponse au demandeur", async () => {
    mocks.fetchRequests.mockResolvedValue(list([{ ...WITHDRAWAL, requestType: "objection" }]));
    renderPanel();

    const status = await screen.findByLabelText("Statut");
    fireEvent.change(status, { target: { value: "rejected" } });
    fireEvent.change(screen.getByPlaceholderText("Ex. access_copy_delivered"), {
      target: { value: "objection_refused" },
    });
    const save = screen.getByRole("button", { name: "Enregistrer le traitement" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Réponse au demandeur/), {
      target: { value: "Motif impérieux et légitime : obligation de publication." },
    });
    fireEvent.click(save);
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
    expect(mocks.update.mock.calls[0][0]).toMatchObject({
      status: "rejected",
      response: "Motif impérieux et légitime : obligation de publication.",
    });
  });
});
