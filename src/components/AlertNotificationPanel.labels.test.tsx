// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/toast", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
vi.mock("@/lib/client-api", () => ({ updateAlertNotification: vi.fn() }));
vi.mock("@/components/AlertEmailRecapToggle", () => ({ AlertEmailRecapToggle: () => null }));

import AlertNotificationPanel from "./AlertNotificationPanel";

afterEach(cleanup);

const notification = (overrides: Record<string, unknown>) => ({
  id: "n1",
  saleId: "sale-1",
  saleTitle: "Appartement à Lyon",
  alertName: "Lyon",
  city: "Lyon",
  department: "69",
  reasons: [],
  marketDiscountPct: null,
  readAt: null,
  scheduledFor: "2026-10-19T10:00:00Z",
  ...overrides,
});

function renderPanel(notifications: unknown[]) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AlertNotificationPanel
        mobile={false}
        userId="u1"
        notifications={notifications as never}
        isLoading={false}
        isFetching={false}
        isError={false}
        onRefresh={vi.fn()}
        onClose={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

describe("AlertNotificationPanel : libellés", () => {
  it("écrit « Pépite » (le libellé du repère) au lieu du motif interne « pépite »", () => {
    renderPanel([notification({ reasons: ["pépite", "DPE C"] })]);
    expect(screen.getByText("Pépite")).toBeTruthy();
    expect(screen.queryByText("pépite")).toBeNull();
    expect(screen.getByText("DPE C")).toBeTruthy();
  });

  it("écrit « N % sous la valeur estimée (base DVF) » et non « décote »", () => {
    renderPanel([notification({ marketDiscountPct: 24.6 })]);
    expect(screen.getByText("25 % sous la valeur estimée (base DVF)")).toBeTruthy();
    expect(document.body.textContent).not.toContain("décote");
  });
});
