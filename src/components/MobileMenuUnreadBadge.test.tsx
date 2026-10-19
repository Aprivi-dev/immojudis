// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileMenuUnreadBadge } from "./MobileMenuUnreadBadge";
import { MOBILE_MENU_UNREAD_ID } from "./mobile-menu-unread";

const state = vi.hoisted(() => ({
  user: { id: "user-1" } as { id: string } | null,
  list: vi.fn(),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: state.user, loading: false }),
}));
vi.mock("@/lib/client-api", () => ({ fetchAlertNotifications: state.list }));

const notification = (id: string, readAt: string | null) => ({ id, readAt });

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MobileMenuUnreadBadge />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.user = { id: "user-1" };
});
afterEach(cleanup);

describe("pastille de non-lus du menu mobile", () => {
  it("affiche le nombre de notifications non lues et le décrit aux lecteurs d'écran", async () => {
    state.list.mockResolvedValue({
      notifications: [
        notification("a", null),
        notification("b", null),
        notification("c", "2026-10-19T08:00:00Z"),
      ],
    });
    setup();
    expect((await screen.findByTestId("mobile-menu-unread")).textContent).toBe("2");
    const description = document.getElementById(MOBILE_MENU_UNREAD_ID);
    expect(description?.textContent).toBe("2 notifications d'alertes non lues");
  });

  it("écrit « 9+ » au-delà de neuf et accorde le singulier", async () => {
    state.list.mockResolvedValue({
      notifications: Array.from({ length: 11 }, (_, index) => notification(String(index), null)),
    });
    const first = setup();
    expect((await screen.findByTestId("mobile-menu-unread")).textContent).toBe("9+");
    first.unmount();

    state.list.mockResolvedValue({ notifications: [notification("a", null)] });
    setup();
    await waitFor(() =>
      expect(document.getElementById(MOBILE_MENU_UNREAD_ID)?.textContent).toBe(
        "1 notification d'alerte non lue",
      ),
    );
  });

  it("n'affiche rien quand tout est lu, ni sans compte connecté", async () => {
    state.list.mockResolvedValue({ notifications: [notification("a", "2026-10-19T08:00:00Z")] });
    const first = setup();
    await waitFor(() => expect(state.list).toHaveBeenCalled());
    expect(screen.queryByTestId("mobile-menu-unread")).toBeNull();
    expect(document.getElementById(MOBILE_MENU_UNREAD_ID)).toBeNull();
    first.unmount();

    state.user = null;
    state.list.mockClear();
    setup();
    expect(screen.queryByTestId("mobile-menu-unread")).toBeNull();
    expect(state.list).not.toHaveBeenCalled();
  });
});
