// @vitest-environment jsdom

import type { AnchorHTMLAttributes } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminCatalogueReadinessPanel } from "./AdminCatalogueReadinessPanel";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), action: vi.fn() }));

vi.mock("@/lib/client-api", () => ({
  fetchAdminCatalogueReadiness: mocks.fetch,
  runAdminCatalogueReadinessActionClient: mocks.action,
}));
vi.mock("@/lib/router-compat", () => ({
  Link: ({
    to,
    params,
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    to: string;
    params?: Record<string, string>;
  }) => (
    <a href={params?.id ? `/sales/${params.id}` : to} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("AdminCatalogueReadinessPanel", () => {
  it("opens the admin composer from a queue row in one click", async () => {
    mocks.fetch.mockResolvedValue(overview());
    const onPrepareInformationRequest = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <AdminCatalogueReadinessPanel onPrepareInformationRequest={onPrepareInformationRequest} />
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Ouvrir le message" }));

    expect(onPrepareInformationRequest).toHaveBeenCalledTimes(1);
    expect(onPrepareInformationRequest).toHaveBeenCalledWith({
      saleId: "11111111-1111-4111-8111-111111111111",
      title: "Appartement T3",
      recipientName: "Cabinet source",
      recipientContact: "cabinet@example.test · 01 02 03",
    });
  });
});

function overview() {
  return {
    policy: {
      enforcementEnabled: true,
      policyVersion: "v1",
      premiumReadyMin: 70,
      minimumScoreConfidence: 0.8,
      updatedAt: "2026-10-08T08:00:00Z",
    },
    counts: {
      unassessed: 0,
      internal_only: 1,
      needs_enrichment: 1,
      premium_ready: 3,
    },
    activeSales: 5,
    pendingEvaluations: 0,
    canEnableEnforcement: true,
    queueTotal: 1,
    queueOffset: 0,
    queueLimit: 100,
    items: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        title: "Appartement T3",
        city: "Bordeaux",
        department: "33",
        saleDate: "2026-11-10T10:00:00Z",
        sourceName: "Source test",
        lawyerName: "Cabinet source",
        lawyerContact: "cabinet@example.test · 01 02 03",
        scoreConfidence: 0.9,
        readinessScore: 42,
        readinessStatus: "needs_enrichment",
        policyVersion: "v1",
        factors: {},
        blockers: [],
        missingFields: ["diagnostics"],
        evaluatedAt: "2026-10-08T08:00:00Z",
        override: null,
        overrideReason: null,
        overrideExpiresAt: null,
      },
    ],
  };
}
