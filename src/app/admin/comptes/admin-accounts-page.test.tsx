// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingOfferState } from "@/hooks/use-billing-offer";
import { AdminAccountsPage } from "./admin-accounts-page";

const mocks = vi.hoisted(() => ({ offer: vi.fn(), reload: vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { email: "admin@example.test" } }) }));
vi.mock("@/hooks/use-billing-offer", () => ({
  useBillingOffer: (enabled: boolean) => ({ offer: mocks.offer(enabled), reload: mocks.reload }),
}));
vi.mock("@/components/admin/AdminShell", () => ({
  AdminPanel: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  AdminShell: ({
    children,
    title,
    onRefresh,
  }: {
    children: ReactNode;
    title: string;
    onRefresh: () => void;
  }) => (
    <main>
      <h1>{title}</h1>
      <button type="button" onClick={onRefresh}>
        Actualiser
      </button>
      {children}
    </main>
  ),
}));
// Chaque panneau a son propre test : ici, seuls les onglets et la condition d'affichage comptent.
vi.mock("@/components/admin/AdminSignupsPanel", () => ({
  SIGNUPS_QUERY_KEY: ["admin-signups"],
  AdminSignupsPanel: () => <p>Panneau des inscriptions</p>,
}));
vi.mock("@/components/admin/AdminLaunchOfferPanel", () => ({
  LAUNCH_OFFER_QUERY_KEY: ["admin-launch-offer"],
  AdminLaunchOfferPanel: () => <p>Panneau de l’essai gratuit</p>,
}));
vi.mock("@/components/admin/AdminOfferOpeningPanel", () => ({
  OFFER_OPENING_AUDIENCE_QUERY_KEY: ["admin-offer-opening-audience"],
  AdminOfferOpeningPanel: () => <p>Prévenir la liste d’attente</p>,
}));
vi.mock("@/components/admin/AdminSubscriptionsPanel", () => ({
  AdminSubscriptionsPanel: () => <p>Panneau des abonnements</p>,
}));

const ready = (open: boolean): BillingOfferState => ({
  status: "ready",
  configured: open,
  open,
  trialAvailable: false,
  label: null,
});

beforeEach(() => {
  mocks.offer.mockReturnValue(ready(false));
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  window.history.replaceState(null, "", "/");
});

function renderPage(url = "/admin/comptes") {
  window.history.replaceState(null, "", url);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AdminAccountsPage />
    </QueryClientProvider>,
  );
}

describe("AdminAccountsPage", () => {
  it("ouvre les inscriptions par défaut, sans lire l'offre, et passe aux clients par l'onglet", async () => {
    renderPage();

    expect(await screen.findByText("Panneau des inscriptions")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Comptes");
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Inscriptions",
      "Clients & abonnements",
    ]);
    expect(mocks.offer).not.toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByRole("tab", { name: "Clients & abonnements" }));
    expect(screen.getByText("Panneau des abonnements")).toBeTruthy();
    expect(screen.queryByText("Panneau des inscriptions")).toBeNull();
    expect(window.location.search).toBe("?onglet=clients");
    expect(mocks.offer).toHaveBeenLastCalledWith(true);
  });

  it("ouvre l'onglet demandé par l'adresse (ancienne adresse /admin/clients)", async () => {
    renderPage("/admin/comptes?onglet=clients");

    expect(await screen.findByText("Panneau des abonnements")).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: "Clients & abonnements" }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it.each<[string, BillingOfferState]>([
    ["fermée", ready(false)],
    ["en cours de lecture", { status: "loading" }],
  ])("masque « Prévenir la liste d'attente » quand l'offre est %s", async (_, offer) => {
    mocks.offer.mockReturnValue(offer);
    renderPage("/admin/comptes?onglet=clients");

    expect(await screen.findByText("Panneau de l’essai gratuit")).toBeTruthy();
    expect(screen.queryByText("Prévenir la liste d’attente")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("montre « Prévenir la liste d'attente » dès que l'offre Analyse est ouverte", async () => {
    mocks.offer.mockReturnValue(ready(true));
    renderPage("/admin/comptes?onglet=clients");

    expect(await screen.findByText("Prévenir la liste d’attente")).toBeTruthy();
  });

  it("dit pourquoi la liste d'attente n'apparaît pas quand l'offre est illisible, et relit", async () => {
    mocks.offer.mockReturnValue({ status: "error" });
    renderPage("/admin/comptes?onglet=clients");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("L’état de l’offre Analyse n’a pas pu être lu");
    expect(screen.queryByText("Prévenir la liste d’attente")).toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: "Réessayer" }));
    expect(mocks.reload).toHaveBeenCalledTimes(1);
  });

  it("relit l'offre avec « Actualiser » sur l'onglet Clients seulement", async () => {
    renderPage();
    await screen.findByText("Panneau des inscriptions");
    fireEvent.click(screen.getByRole("button", { name: "Actualiser" }));
    expect(mocks.reload).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("tab", { name: "Clients & abonnements" }));
    fireEvent.click(screen.getByRole("button", { name: "Actualiser" }));
    expect(mocks.reload).toHaveBeenCalledTimes(1);
  });
});
