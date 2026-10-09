// @vitest-environment jsdom

import type * as React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BillingActions } from "./BillingActions";

type MockLinkProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  to?: string;
  search?: Record<string, unknown>;
};

const mocks = vi.hoisted(() => ({
  user: { id: "investor" } as { id: string } | null,
  loading: false,
  navigate: vi.fn(),
  fetchAccessPlan: vi.fn(),
  fetchBillingOffer: vi.fn(),
  startAnalyseCheckout: vi.fn(),
  openBillingPortal: vi.fn(),
  legalPublisherConfigurationStatus: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: mocks.user, loading: mocks.loading }),
}));

vi.mock("@/lib/router-compat", () => ({
  useNavigate: () => mocks.navigate,
  Link: ({ children, to, search: _search, ...props }: MockLinkProps) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/lib/client-billing", () => ({
  fetchAccessPlan: mocks.fetchAccessPlan,
  fetchBillingOffer: mocks.fetchBillingOffer,
  startAnalyseCheckout: mocks.startAnalyseCheckout,
  openBillingPortal: mocks.openBillingPortal,
}));

vi.mock("@/lib/legal-documents", () => ({
  LEGAL_DOCUMENTS: {
    terms: { version: "terms-v1" },
    privacy: { version: "privacy-v1" },
  },
  legalPublisherConfigurationStatus: mocks.legalPublisherConfigurationStatus,
}));

vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  mocks.user = { id: "investor" };
  mocks.loading = false;
  mocks.fetchAccessPlan.mockResolvedValue({
    plan: { plan: "decouverte", currentPeriodEnd: null },
  });
  mocks.fetchBillingOffer.mockResolvedValue({
    configured: true,
    trialDays: 7,
    label: "Tarif récurrent indiqué au paiement",
  });
  mocks.startAnalyseCheckout.mockRejectedValue(new Error("test checkout arrêté"));
  mocks.openBillingPortal.mockRejectedValue(new Error("test portail arrêté"));
  mocks.legalPublisherConfigurationStatus.mockReturnValue({ ready: false, missing: ["publisher"] });
});

function renderActions() {
  return render(<BillingActions />);
}

describe("BillingActions", () => {
  it("suspends purchase when legal identity is incomplete but keeps the Analyse portal available", async () => {
    mocks.fetchAccessPlan.mockResolvedValue({
      plan: { plan: "analyse", currentPeriodEnd: "2026-12-01T00:00:00.000Z" },
    });
    renderActions();

    const purchase = screen.getByRole("button", {
      name: "Paiement temporairement indisponible",
    }) as HTMLButtonElement;
    expect(purchase.disabled).toBe(true);
    expect(screen.getByRole("link", { name: "Voir les mentions légales" })).toBeTruthy();

    const portal = await screen.findByRole("button", { name: /Actif jusqu/ });
    expect((portal as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(portal);

    await waitFor(() => expect(mocks.openBillingPortal).toHaveBeenCalledTimes(1));
    expect(mocks.startAnalyseCheckout).not.toHaveBeenCalled();
  });

  it("lets a subscriber whose renewal failed update the card instead of re-subscribing", async () => {
    mocks.legalPublisherConfigurationStatus.mockReturnValue({ ready: true, missing: [] });
    mocks.fetchAccessPlan.mockResolvedValue({
      plan: {
        plan: "decouverte",
        currentPeriodEnd: null,
        billing: { status: "past_due", hasStripeCustomer: true, graceEndsAt: null },
      },
    });
    renderActions();

    const manage = await screen.findByRole("button", { name: "Gérer mon abonnement" });
    expect((manage as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("button", { name: /Démarrer l’essai|Souscrire/ })).toBeNull();

    fireEvent.click(manage);
    await waitFor(() => expect(mocks.openBillingPortal).toHaveBeenCalledTimes(1));
    expect(mocks.startAnalyseCheckout).not.toHaveBeenCalled();
  });

  it("opens the configured offer recap and requires both consents before checkout", async () => {
    mocks.legalPublisherConfigurationStatus.mockReturnValue({ ready: true, missing: [] });
    renderActions();

    fireEvent.click(await screen.findByRole("button", { name: "Démarrer l’essai Analyse" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Récapitulatif avant paiement")).toBeTruthy();

    const confirm = screen.getByRole("button", {
      name: "Commander avec obligation de paiement",
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(mocks.startAnalyseCheckout).not.toHaveBeenCalled();

    const consents = screen.getAllByRole("checkbox");
    fireEvent.click(consents[0]);
    expect(confirm.disabled).toBe(true);
    expect(mocks.startAnalyseCheckout).not.toHaveBeenCalled();

    fireEvent.click(consents[1]);
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(mocks.startAnalyseCheckout).toHaveBeenCalledWith({
        consent: {
          termsAccepted: true,
          termsVersion: "terms-v1",
          privacyVersion: "privacy-v1",
          paymentObligationAcknowledged: true,
          immediatePerformanceRequested: true,
          withdrawalInformationAcknowledged: true,
        },
      }),
    );
  });

  it("offers a recurring subscription without a second trial after trial history", async () => {
    mocks.legalPublisherConfigurationStatus.mockReturnValue({ ready: true, missing: [] });
    mocks.fetchBillingOffer.mockResolvedValue({
      configured: true,
      trialDays: 7,
      trialAvailable: false,
      label: "Tarif récurrent indiqué au paiement",
    });
    renderActions();

    fireEvent.click(await screen.findByRole("button", { name: "Souscrire à Analyse" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Abonnement immédiat, sans nouvel essai")).toBeTruthy();
    expect(screen.getByText(/Carte bancaire requise\./)).toBeTruthy();
  });

  it("loads the public offer for visitors and redirects them to login", async () => {
    mocks.user = null;
    mocks.legalPublisherConfigurationStatus.mockReturnValue({ ready: true, missing: [] });
    renderActions();

    const purchase = await screen.findByRole("button", { name: "Démarrer l’essai Analyse" });
    expect((purchase as HTMLButtonElement).disabled).toBe(false);
    expect(mocks.fetchBillingOffer).toHaveBeenCalledTimes(1);
    expect(mocks.fetchAccessPlan).not.toHaveBeenCalled();

    fireEvent.click(purchase);

    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith({
        to: "/login",
        search: { redirect: expect.stringContaining("/") },
      }),
    );
  });
});
