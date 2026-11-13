// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminPageMeta } from "@/lib/admin-pagination";
import type {
  AdminSubscriptionListResponse,
  AdminSubscriptionSummary,
} from "@/lib/admin-subscriptions";

const mocks = vi.hoisted(() => ({ list: vi.fn(), grant: vi.fn() }));

vi.mock("@/lib/client-api", () => ({
  fetchAdminSubscriptions: mocks.list,
  grantAdminSubscription: mocks.grant,
}));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AdminSubscriptionsPanel } from "./AdminSubscriptionsPanel";

const TOTAL = 51;

function subscription(index: number): AdminSubscriptionSummary {
  return {
    userId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    email: `client${index}@exemple.fr`,
    planCode: "analyse",
    status: "active",
    currentPeriodEnd: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    metadata: {},
    createdAt: "2026-11-01T09:00:00.000Z",
    updatedAt: "2026-11-01T09:00:00.000Z",
  };
}

function page({ offset = 0, limit = 50 }: { offset?: number; limit?: number }) {
  const count = Math.max(0, Math.min(limit, TOTAL - offset));
  return {
    subscriptions: Array.from({ length: count }, (_, index) => subscription(offset + index)),
    activeCount: TOTAL,
    truncated: true,
    ...adminPageMeta({ offset, limit, total: TOTAL }),
  } satisfies AdminSubscriptionListResponse;
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AdminSubscriptionsPanel />
    </QueryClientProvider>,
  );
}

describe("AdminSubscriptionsPanel", () => {
  beforeEach(() => {
    mocks.list.mockImplementation(async (input: { offset?: number }) => page(input));
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("reaches the second page when there are 51 subscriptions", async () => {
    renderPanel();

    expect(await screen.findByText("1–50 sur 51 · page 1 sur 2")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Précédent — accès payants" })).toHaveProperty(
      "disabled",
      true,
    );

    fireEvent.click(screen.getByRole("button", { name: "Suivant — accès payants" }));

    expect(await screen.findByText("51–51 sur 51 · page 2 sur 2")).toBeTruthy();
    expect(mocks.list).toHaveBeenLastCalledWith({ offset: 50 });
    expect(screen.getByText("client50@exemple.fr")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Suivant — accès payants" })).toHaveProperty(
      "disabled",
      true,
    );

    fireEvent.click(screen.getByRole("button", { name: "Précédent — accès payants" }));
    expect(await screen.findByText("1–50 sur 51 · page 1 sur 2")).toBeTruthy();
  });
});
