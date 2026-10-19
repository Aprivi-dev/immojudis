// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SaleUnlockStatus } from "@/lib/sale-unlocks";

const mocks = vi.hoisted(() => ({
  plan: vi.fn(),
  overview: vi.fn(),
  preferences: vi.fn(),
  updatePreferences: vi.fn(),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { id: "u1", email: "a@b.test" } }) }));
vi.mock("@/lib/client-billing", () => ({ fetchAccessPlan: mocks.plan }));
vi.mock("@/lib/client-api", () => ({
  fetchSaleUnlocksOverview: mocks.overview,
  fetchAccessPlan: mocks.plan,
  fetchNotificationPreferences: mocks.preferences,
  updateNotificationPreferences: mocks.updatePreferences,
}));
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
  mocks.preferences.mockReset();
  mocks.updatePreferences.mockReset();
  mocks.preferences.mockResolvedValue({ preferences: { alertEmailEnabled: false } });
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

  it("regroupe l'espace personnel dans « Mon espace », avec les ventes débloquées", async () => {
    mocks.plan.mockResolvedValue({
      plan: { plan: "decouverte", label: "Découverte", hasAnalysisAccess: false },
    });
    mocks.overview.mockResolvedValue({ status: status(), sales: [] });
    renderPage();

    const space = within(await screen.findByRole("region", { name: "Mon espace" }));
    await screen.findByText(/2 sur 3 utilisés/);
    const hrefs = space.getAllByRole("link").map((link) => link.getAttribute("href"));
    expect(hrefs).toEqual(["/favoris", "/alertes", "/compte/ventes-debloquees", "/comparaisons"]);
    expect(space.getByRole("link", { name: "Mes favoris" })).toBeTruthy();
    expect(space.getByRole("link", { name: "Mes ventes débloquées" })).toBeTruthy();
  });

  it("n'y met pas « Mes ventes débloquées » pour un compte Analyse", async () => {
    mocks.plan.mockResolvedValue({
      plan: { plan: "analyse", label: "Analyse", hasAnalysisAccess: true },
    });
    renderPage();

    const space = within(await screen.findByRole("region", { name: "Mon espace" }));
    await screen.findByText("Analyse");
    expect(space.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
      "/favoris",
      "/alertes",
      "/comparaisons",
    ]);
  });

  it("propose dans « Notifications » le même interrupteur d'email que la cloche, décoché par défaut", async () => {
    mocks.plan.mockResolvedValue({
      plan: { plan: "decouverte", label: "Découverte", hasAnalysisAccess: false },
    });
    mocks.overview.mockResolvedValue({ status: status(), sales: [] });
    mocks.updatePreferences.mockResolvedValue({ preferences: { alertEmailEnabled: true } });
    renderPage();

    const notifications = within(await screen.findByRole("region", { name: "Notifications" }));
    const checkbox = (await notifications.findByRole("checkbox")) as HTMLInputElement;
    await waitFor(() => expect(checkbox.disabled).toBe(false));
    expect(checkbox.checked).toBe(false);
    expect(
      notifications.getByText("Cochez pour recevoir un email récapitulatif chaque semaine"),
    ).toBeTruthy();

    fireEvent.click(checkbox);
    await waitFor(() => expect(mocks.updatePreferences).toHaveBeenCalled());
    expect(mocks.updatePreferences.mock.calls[0][0]).toEqual({
      alertEmailEnabled: true,
      consentSource: "settings",
    });
  });

  it("propose les rappels d'audience, décochés et distincts des alertes, quand l'envoi est ouvert", async () => {
    mocks.plan.mockResolvedValue({
      plan: { plan: "decouverte", label: "Découverte", hasAnalysisAccess: false },
    });
    mocks.overview.mockResolvedValue({ status: status(), sales: [] });
    mocks.preferences.mockResolvedValue({
      preferences: { alertEmailEnabled: false, saleRemindersEnabled: false },
      saleRemindersAvailable: true,
    });
    mocks.updatePreferences.mockResolvedValue({});
    renderPage();

    const notifications = within(await screen.findByRole("region", { name: "Notifications" }));
    await waitFor(() => expect(notifications.getAllByRole("checkbox")).toHaveLength(2));
    const boxes = notifications.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.every((box) => !box.checked)).toBe(true);
    await waitFor(() => expect(boxes.every((box) => !box.disabled)).toBe(true));
    fireEvent.click(boxes[1]);
    await waitFor(() => expect(mocks.updatePreferences).toHaveBeenCalled());
    expect(mocks.updatePreferences.mock.calls[0][0]).toEqual({
      saleRemindersEnabled: true,
      consentSource: "settings",
    });
  });

  it("ne montre que la case des alertes tant que les rappels d'audience ne sont pas ouverts", async () => {
    mocks.plan.mockResolvedValue({
      plan: { plan: "decouverte", label: "Découverte", hasAnalysisAccess: false },
    });
    mocks.overview.mockResolvedValue({ status: status(), sales: [] });
    mocks.preferences.mockResolvedValue({
      preferences: { alertEmailEnabled: false, saleRemindersEnabled: false },
      saleRemindersAvailable: false,
    });
    renderPage();

    const notifications = within(await screen.findByRole("region", { name: "Notifications" }));
    await notifications.findByRole("checkbox");
    await waitFor(() => expect(mocks.preferences).toHaveBeenCalled());
    expect(notifications.getAllByRole("checkbox")).toHaveLength(1);
    expect(screen.queryByText("Rappels d’audience et avertissements")).toBeNull();
  });
});
