// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlertNotificationCenter } from "./AlertNotificationCenter";
const state = vi.hoisted(() => ({
  userId: "first" as string | null,
  list: vi.fn(),
  preferences: vi.fn(),
  entitlements: vi.fn(),
  updatePreferences: vi.fn(),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: state.userId ? { id: state.userId } : null, loading: false }),
}));
vi.mock("@/lib/client-api", () => ({
  fetchAlertNotifications: state.list,
  fetchAccessPlan: state.entitlements,
  fetchNotificationPreferences: state.preferences,
  updateAlertNotification: vi.fn(),
  updateNotificationPreferences: state.updatePreferences,
}));
afterEach(cleanup);
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
});
