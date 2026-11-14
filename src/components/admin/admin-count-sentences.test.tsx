// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Phrases de comptage des listes Avocats et Conformité : une réponse sans `total` ne doit plus
// afficher « sur undefined » (même garde que la pagination, `adminKnownTotal`).
const mocks = vi.hoisted(() => ({ referrals: vi.fn(), privacy: vi.fn() }));
vi.mock("@/lib/client-api", () => ({
  fetchAdminLawyerReferralRequests: mocks.referrals,
  updateAdminLawyerReferralRequest: vi.fn(),
  fetchAdminPrivacyRequests: mocks.privacy,
  updateAdminPrivacyRequest: vi.fn(),
  executeAdminContractWithdrawal: vi.fn(),
  executeAdminPrivacyErasure: vi.fn(),
  fetchAdminProfessionalPrivacyExport: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AdminLawyerReferralRequestsPanel } from "./AdminLawyerReferralRequestsPanel";
import { AdminPrivacyRequestsPanel } from "./AdminPrivacyRequestsPanel";

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function renderPanel(panel: ReactElement) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {panel}
    </QueryClientProvider>,
  );
}

describe("phrases de comptage sans total", () => {
  it("Avocats : « 0 demande récente affichée sur 0 », sans « undefined »", async () => {
    mocks.referrals.mockResolvedValue({ requests: [], lawyers: [] });
    const { container } = renderPanel(<AdminLawyerReferralRequestsPanel />);

    expect(await screen.findByText(/affichée sur 0\./)).toBeTruthy();
    expect(container.textContent).not.toMatch(/undefined|NaN/);
  });

  it("Conformité : « 0 demande récente affichée sur 0 », sans « undefined »", async () => {
    mocks.privacy.mockResolvedValue({ requests: [] });
    const { container } = renderPanel(<AdminPrivacyRequestsPanel />);

    expect(await screen.findByText(/affichée sur 0\./)).toBeTruthy();
    expect(container.textContent).not.toMatch(/undefined|NaN/);
  });
});
