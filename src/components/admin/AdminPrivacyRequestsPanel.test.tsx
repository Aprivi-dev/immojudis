// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrivacyRequestAdminSummary } from "@/lib/privacy-requests";
import { AdminPrivacyRequestsPanel } from "./AdminPrivacyRequestsPanel";

const mocks = vi.hoisted(() => ({
  fetchRequests: vi.fn(),
  withdraw: vi.fn(),
}));

vi.mock("@/lib/client-api", () => ({
  executeAdminContractWithdrawal: mocks.withdraw,
  executeAdminPrivacyErasure: vi.fn(),
  fetchAdminPrivacyRequests: mocks.fetchRequests,
  fetchAdminProfessionalPrivacyExport: vi.fn(),
  updateAdminPrivacyRequest: vi.fn(),
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
};

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
