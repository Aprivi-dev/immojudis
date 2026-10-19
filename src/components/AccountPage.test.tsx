// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SaleUnlockStatus } from "@/lib/sale-unlocks";

const mocks = vi.hoisted(() => ({ plan: vi.fn(), overview: vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { id: "u1", email: "a@b.test" } }) }));
vi.mock("@/lib/client-billing", () => ({ fetchAccessPlan: mocks.plan }));
vi.mock("@/lib/client-api", () => ({ fetchSaleUnlocksOverview: mocks.overview }));
vi.mock("@/components/BillingActions", () => ({ BillingActions: () => <div>Actions</div> }));

import { AccountPage } from "./AccountPage";

const status = (overrides: Partial<SaleUnlockStatus> = {}): SaleUnlockStatus => ({
  saleId: null,
  unlocked: false,
  unlockable: true,
  analysisAccess: false,
  limit: 3,
  used: 2,
  remaining: 1,
  periodStart: "2026-09-30T22:00:00.000Z",
  resetsAt: "2026-10-31T23:00:00.000Z",
  ...overrides,
});

function renderPage() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <AccountPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.plan.mockReset();
  mocks.overview.mockReset();
});
afterEach(cleanup);

describe("AccountPage unlocks", () => {
  it("shows the month so far, the reset date and the way to the unlocked sales", async () => {
    mocks.plan.mockResolvedValue({
      plan: { plan: "decouverte", label: "Découverte", hasAnalysisAccess: false },
    });
    mocks.overview.mockResolvedValue({ status: status(), sales: [] });
    renderPage();

    expect(
      await screen.findByText(
        "Déblocages ce mois-ci : 2 sur 3 utilisés. Remis à 3 le 1er novembre.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Mes ventes débloquées" }).getAttribute("href")).toBe(
      "/compte/ventes-debloquees",
    );
  });

  it("says so, with the link, when the counter cannot be read", async () => {
    mocks.plan.mockResolvedValue({
      plan: { plan: "decouverte", label: "Découverte", hasAnalysisAccess: false },
    });
    mocks.overview.mockRejectedValue(new Error("indisponible"));
    renderPage();

    expect(
      await screen.findByText("Le suivi de vos déblocages est indisponible pour le moment."),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Mes ventes débloquées" })).toBeTruthy();
  });

  it("does not mention unlocks to an Analyse account, which opens every sale", async () => {
    mocks.plan.mockResolvedValue({
      plan: { plan: "analyse", label: "Analyse", hasAnalysisAccess: true },
    });
    renderPage();

    await screen.findByText("Analyse");
    expect(screen.queryByTestId("account-unlocks")).toBeNull();
    expect(mocks.overview).not.toHaveBeenCalled();
  });

  it("keeps the subscription actions next to the counter", async () => {
    mocks.plan.mockResolvedValue({
      plan: { plan: "decouverte", label: "Découverte", hasAnalysisAccess: false },
    });
    mocks.overview.mockResolvedValue({ status: status({ used: 0, remaining: 3 }), sales: [] });
    renderPage();
    expect(await screen.findByText(/0 sur 3 utilisés/)).toBeTruthy();
    expect(screen.getByText("Actions")).toBeTruthy();
  });
});
