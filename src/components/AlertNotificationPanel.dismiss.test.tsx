// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
  update: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({ toast: mocks.toast }));
vi.mock("@/lib/client-api", () => ({ updateAlertNotification: mocks.update }));
vi.mock("@/components/AlertEmailRecapToggle", () => ({ AlertEmailRecapToggle: () => null }));

import AlertNotificationPanel from "./AlertNotificationPanel";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AlertNotificationPanel : « Annuler » après avoir masqué une notification", () => {
  it("ne s'éteint pas au bout de 5 s : l'action reste jusqu'à ce qu'on la ferme", async () => {
    mocks.update.mockResolvedValue({});
    const notification = {
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
    };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AlertNotificationPanel
          mobile={false}
          userId="u1"
          notifications={[notification] as never}
          isLoading={false}
          isFetching={false}
          isError={false}
          onRefresh={vi.fn()}
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Masquer" }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalled());
    const [message, options] = mocks.toast.mock.calls[0];
    expect(message).toBe("Notification masquée");
    expect(options.action.label).toBe("Annuler");
    expect(options.duration).toBe(Infinity);
    expect(options.closeButton).toBe(true);
    expect(options.id).toBe("alert-notification-dismissed");
  });
});
