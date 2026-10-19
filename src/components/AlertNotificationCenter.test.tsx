// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestOpenNotifications } from "@/lib/notification-center-events";
import { AlertNotificationCenter } from "./AlertNotificationCenter";
const state = vi.hoisted(() => ({
  userId: "first" as string | null,
  list: vi.fn(),
  preferences: vi.fn(),
  entitlements: vi.fn(),
  updatePreferences: vi.fn(),
  updateNotification: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: state.userId ? { id: state.userId } : null, loading: false }),
}));
vi.mock("@/lib/client-api", () => ({
  fetchAlertNotifications: state.list,
  fetchAccessPlan: state.entitlements,
  fetchNotificationPreferences: state.preferences,
  updateAlertNotification: state.updateNotification,
  updateNotificationPreferences: state.updatePreferences,
}));
vi.mock("@/lib/toast", () => ({
  toast: Object.assign(state.toast, { error: vi.fn(), success: vi.fn() }),
}));
afterEach(cleanup);

const unreadNotification = {
  id: "n1",
  saleId: "sale-1",
  saleTitle: "Maison à Bordeaux",
  alertName: "Bordeaux",
  city: "Bordeaux",
  department: "33",
  reasons: [],
  marketDiscountPct: null,
  readAt: null,
  scheduledFor: "2026-10-19T08:00:00Z",
};
beforeEach(() => {
  vi.clearAllMocks();
  state.userId = "first";
  state.list.mockResolvedValue({ notifications: [] });
  state.entitlements.mockResolvedValue({ plan: { hasAnalysisAccess: false } });
  state.preferences.mockResolvedValue({ preferences: { alertEmailEnabled: true } });
});
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = () => (
    <QueryClientProvider client={client}>
      <AlertNotificationCenter />
    </QueryClientProvider>
  );
  return { ...render(view()), view, client };
}
describe("notification panel", () => {
  it("loads preferences only on opening and lets a Discovery account use the weekly email", async () => {
    setup();
    await waitFor(() => expect(state.list).toHaveBeenCalledOnce());
    expect(state.preferences).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    const checkbox = (await screen.findByRole("checkbox")) as HTMLInputElement;
    await waitFor(() => expect(state.preferences).toHaveBeenCalledOnce());
    await waitFor(() => expect(checkbox.disabled).toBe(false));
    expect(checkbox.checked).toBe(true);
    expect(screen.getByText(/un email récapitulatif par semaine/)).toBeTruthy();
    expect(screen.queryByText(/réservés à Analyse/)).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("lets a Discovery account opt in from the settings, without pre-ticking the box", async () => {
    state.preferences.mockResolvedValue({ preferences: { alertEmailEnabled: false } });
    state.updatePreferences.mockResolvedValue({ preferences: { alertEmailEnabled: true } });
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    const checkbox = (await screen.findByRole("checkbox")) as HTMLInputElement;
    await waitFor(() => expect(checkbox.disabled).toBe(false));
    expect(checkbox.checked).toBe(false);
    expect(
      screen.getByText("Cochez pour recevoir un email récapitulatif chaque semaine"),
    ).toBeTruthy();
    fireEvent.click(checkbox);
    await waitFor(() => expect(state.updatePreferences).toHaveBeenCalled());
    expect(state.updatePreferences.mock.calls[0][0]).toEqual({
      alertEmailEnabled: true,
      consentSource: "settings",
    });
  });
  it("reports fetch errors without presenting an empty inbox", async () => {
    state.list.mockRejectedValue(new Error("offline"));
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    await screen.findByRole("alert");
    expect(screen.queryByText("Aucune alerte")).toBeNull();
  });
  it("closes the previous account panel immediately on account change", async () => {
    const ui = setup();
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    await screen.findByRole("dialog");
    state.userId = "second";
    ui.rerender(ui.view());
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() =>
      expect(ui.client.getQueryData(["alert-notifications", "second"])).toEqual({
        notifications: [],
      }),
    );
    state.userId = null;
    ui.rerender(ui.view());
    expect(screen.queryByRole("button", { name: "Notifications" })).toBeNull();
  });

  it("dit qu'aucune nouvelle vente ne correspond aux alertes quand la liste est vide", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    await screen.findByText("Aucune nouvelle vente pour vos alertes pour le moment.");
    expect(screen.queryByText("Aucune alerte")).toBeNull();
  });

  it("donne aux boutons de la cloche une cible de 44 px, espacée de 8 px", async () => {
    state.list.mockResolvedValue({ notifications: [unreadNotification] });
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    const read = await screen.findByRole("button", { name: "Marquer comme lue" });
    const hide = screen.getByRole("button", { name: "Masquer" });
    const refresh = screen.getByRole("button", { name: "Rafraîchir" });
    for (const button of [read, hide, refresh]) {
      expect(button.className).toContain("size-11");
      expect(button.className).not.toContain("h-8");
    }
    expect(read.parentElement).toBe(hide.parentElement);
    expect(read.parentElement!.className).toContain("gap-2");
  });

  it("propose « Annuler » après « Masquer » et rétablit la notification", async () => {
    state.list.mockResolvedValue({ notifications: [unreadNotification] });
    state.updateNotification.mockResolvedValue({ notification: unreadNotification });
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    fireEvent.click(await screen.findByRole("button", { name: "Masquer" }));
    await waitFor(() => expect(state.updateNotification).toHaveBeenCalled());
    expect(state.updateNotification.mock.calls[0][0]).toEqual({
      notificationId: "n1",
      action: "dismiss",
    });
    await waitFor(() => expect(state.toast).toHaveBeenCalled());
    const [message, options] = state.toast.mock.calls[0];
    expect(message).toBe("Notification masquée");
    expect(options.action.label).toBe("Annuler");
    options.action.onClick();
    await waitFor(() => expect(state.updateNotification).toHaveBeenCalledTimes(2));
    expect(state.updateNotification.mock.calls[1][0]).toEqual({
      notificationId: "n1",
      action: "restore",
    });
  });

  it("n'affiche pas « Annuler » après un simple « Marquer comme lue »", async () => {
    state.list.mockResolvedValue({ notifications: [unreadNotification] });
    state.updateNotification.mockResolvedValue({ notification: unreadNotification });
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    fireEvent.click(await screen.findByRole("button", { name: "Marquer comme lue" }));
    await waitFor(() => expect(state.updateNotification).toHaveBeenCalled());
    expect(state.toast).not.toHaveBeenCalled();
  });

  it("s'ouvre quand un message demande de voir les notifications", async () => {
    setup();
    await waitFor(() => expect(state.list).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => requestOpenNotifications());
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });
});
