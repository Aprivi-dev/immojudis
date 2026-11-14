// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminAccountsPage } from "./admin-accounts-page";

const mocks = vi.hoisted(() => ({ offerOpen: vi.fn<() => boolean | null>() }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { email: "admin@example.test" } }) }));
vi.mock("@/hooks/use-analysis-checkout-open", () => ({
  useAnalysisCheckoutOpen: mocks.offerOpen,
}));
vi.mock("@/components/admin/AdminShell", () => ({
  AdminShell: ({ children, title }: { children: ReactNode; title: string }) => (
    <main>
      <h1>{title}</h1>
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

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  window.history.replaceState(null, "", "/");
});

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AdminAccountsPage />
    </QueryClientProvider>,
  );
}

describe("AdminAccountsPage", () => {
  it("ouvre les inscriptions par défaut et passe aux clients par l'onglet", async () => {
    mocks.offerOpen.mockReturnValue(false);
    renderPage();

    expect(await screen.findByText("Panneau des inscriptions")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Comptes");
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Inscriptions",
      "Clients & abonnements",
    ]);

    fireEvent.click(screen.getByRole("tab", { name: "Clients & abonnements" }));
    expect(screen.getByText("Panneau des abonnements")).toBeTruthy();
    expect(screen.queryByText("Panneau des inscriptions")).toBeNull();
    expect(window.location.search).toBe("?onglet=clients");
  });

  it("ouvre l'onglet demandé par l'adresse (ancienne adresse /admin/clients)", async () => {
    mocks.offerOpen.mockReturnValue(false);
    window.history.replaceState(null, "", "/admin/comptes?onglet=clients");
    renderPage();

    expect(await screen.findByText("Panneau des abonnements")).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: "Clients & abonnements" }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it.each<[boolean | null, string]>([
    [false, "fermée"],
    [null, "en cours de lecture"],
  ])("masque « Prévenir la liste d'attente » quand l'offre vaut %s (%s)", async (open) => {
    mocks.offerOpen.mockReturnValue(open);
    window.history.replaceState(null, "", "/admin/comptes?onglet=clients");
    renderPage();

    expect(await screen.findByText("Panneau de l’essai gratuit")).toBeTruthy();
    expect(screen.queryByText("Prévenir la liste d’attente")).toBeNull();
  });

  it("montre « Prévenir la liste d'attente » dès que l'offre Analyse est ouverte", async () => {
    mocks.offerOpen.mockReturnValue(true);
    window.history.replaceState(null, "", "/admin/comptes?onglet=clients");
    renderPage();

    expect(await screen.findByText("Prévenir la liste d’attente")).toBeTruthy();
  });
});
