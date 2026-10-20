// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unavailablePilotage } from "@/lib/admin-pilotage";

const mocks = vi.hoisted(() => ({
  getOffer: vi.fn(),
  setOffer: vi.fn(),
  pilotage: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/client-api", () => ({
  fetchAdminLaunchOffer: mocks.getOffer,
  setAdminLaunchOfferClient: mocks.setOffer,
}));
vi.mock("@/lib/client-api/admin", () => ({ fetchAdminPilotage: mocks.pilotage }));
vi.mock("@/lib/toast", () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock("@/components/admin/AdminShell", () => ({
  AdminPanel: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}));

import { AdminLaunchOfferPanel } from "./AdminLaunchOfferPanel";

function renderPanel() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
    >
      <AdminLaunchOfferPanel />
    </QueryClientProvider>,
  );
}

function pilotageWith(launchOfferAccounts: number | null) {
  const base = unavailablePilotage();
  return { ...base, snapshot: { ...base.snapshot, launchOfferAccounts } };
}

describe("AdminLaunchOfferPanel", () => {
  beforeEach(() => {
    mocks.getOffer.mockResolvedValue({ active: true });
    mocks.setOffer.mockImplementation(async (active: boolean) => ({ active }));
    mocks.pilotage.mockResolvedValue(pilotageWith(27));
    vi.spyOn(window, "confirm").mockImplementation(() => true);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  it("asks for confirmation in a dialog, not with window.confirm, and names the accounts affected", async () => {
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Couper l’offre de lancement" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Couper l’offre de lancement ?")).toBeTruthy();
    expect(await within(dialog).findByText(/27 comptes perdent les avantages/)).toBeTruthy();
    expect(window.confirm).not.toHaveBeenCalled();
    expect(mocks.setOffer).not.toHaveBeenCalled();
  });

  it("cuts the offer only after the confirmation, and announces the new state", async () => {
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Couper l’offre de lancement" }));
    fireEvent.click(await screen.findByRole("button", { name: "Couper l’offre" }));

    await waitFor(() => expect(mocks.setOffer).toHaveBeenCalledWith(false));
    const status = screen.getByRole("status");
    await waitFor(() => expect(status.textContent).toContain("Offre de lancement coupée"));
    expect(mocks.success).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("changes nothing when the administrator cancels", async () => {
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Couper l’offre de lancement" }));
    fireEvent.click(await screen.findByRole("button", { name: "Annuler" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.setOffer).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("says when the number of accounts is not available, and when it is one or none", async () => {
    mocks.pilotage.mockResolvedValue(pilotageWith(null));
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Couper l’offre de lancement" }));
    expect(
      await screen.findByText(/nombre de comptes concernés n’est pas disponible/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Annuler" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    mocks.pilotage.mockResolvedValue(pilotageWith(1));
    fireEvent.click(screen.getByRole("button", { name: "Couper l’offre de lancement" }));
    expect(await screen.findByText(/^1 compte perd les avantages/)).toBeTruthy();
  });

  it("restores the offer without confirmation, since it takes nothing from anyone", async () => {
    mocks.getOffer.mockResolvedValue({ active: false });
    renderPanel();

    await screen.findByRole("heading", { name: "Offre de lancement coupée" });
    fireEvent.click(screen.getByRole("button", { name: "Rétablir l’offre de lancement" }));

    await waitFor(() => expect(mocks.setOffer).toHaveBeenCalledWith(true));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("Offre de lancement rétablie"),
    );
    expect(mocks.pilotage).not.toHaveBeenCalled();
  });

  it("announces a failure instead of staying silent", async () => {
    mocks.setOffer.mockRejectedValue(new Error("Accès refusé"));
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Couper l’offre de lancement" }));
    fireEvent.click(await screen.findByRole("button", { name: "Couper l’offre" }));

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("Offre de lancement non modifiée"),
    );
    expect(mocks.error).toHaveBeenCalledWith("Accès refusé");
  });
});
