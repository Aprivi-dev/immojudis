// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BillingActions } from "./BillingActions";

const mocks = vi.hoisted(() => ({
  user: { id: "investor" } as { id: string } | null,
  loading: false,
  navigate: vi.fn(),
  fetchAccessPlan: vi.fn(),
  fetchBillingOffer: vi.fn(),
  fetchOfferOpeningNotification: vi.fn(),
  updateOfferOpeningNotification: vi.fn(),
  startAnalyseCheckout: vi.fn(),
  openBillingPortal: vi.fn(),
  legalPublisherConfigurationStatus: vi.fn(),
  toastError: vi.fn(),
  track: vi.fn(),
}));
vi.mock("@/lib/product-events", () => ({ trackProductEvent: mocks.track }));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: mocks.user, loading: mocks.loading }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.navigate, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

vi.mock("@/lib/client-billing", () => ({
  fetchAccessPlan: mocks.fetchAccessPlan,
  fetchBillingOffer: mocks.fetchBillingOffer,
  fetchOfferOpeningNotification: mocks.fetchOfferOpeningNotification,
  updateOfferOpeningNotification: mocks.updateOfferOpeningNotification,
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
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
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
  mocks.fetchOfferOpeningNotification.mockResolvedValue({
    notification: { requested: false, consentedAt: null },
  });
  mocks.updateOfferOpeningNotification.mockResolvedValue({
    notification: { requested: true, consentedAt: "2026-10-20T10:00:00.000Z" },
  });
  mocks.startAnalyseCheckout.mockRejectedValue(new Error("test checkout arrêté"));
  mocks.openBillingPortal.mockRejectedValue(new Error("test portail arrêté"));
  mocks.legalPublisherConfigurationStatus.mockReturnValue({ ready: false, missing: ["publisher"] });
});

function renderActions(props: Parameters<typeof BillingActions>[0] = {}) {
  return render(<BillingActions {...props} />);
}

describe("BillingActions", () => {
  it("keeps the Analyse portal available even when the purchase is not open", async () => {
    mocks.fetchAccessPlan.mockResolvedValue({
      plan: { plan: "analyse", currentPeriodEnd: "2026-12-01T00:00:00.000Z" },
    });
    renderActions();

    const manage = await screen.findByRole("button", { name: "Gérer mon abonnement Analyse" });
    expect((manage as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Ouverture prochaine" })).toBeNull();

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
        currentPeriodEnd: "2026-10-01T00:00:00.000Z",
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

  it("offers the subscription again after an abandoned checkout left a Stripe customer", async () => {
    mocks.legalPublisherConfigurationStatus.mockReturnValue({ ready: true, missing: [] });
    // Reservation row written when the payment page opens: customer, no subscription.
    mocks.fetchAccessPlan.mockResolvedValue({
      plan: {
        plan: "decouverte",
        currentPeriodEnd: null,
        billing: { status: "active", hasStripeCustomer: true, graceEndsAt: null },
      },
    });
    renderActions();

    const subscribe = await screen.findByRole("button", { name: "Démarrer l’essai Analyse" });
    expect((subscribe as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("button", { name: /Gérer mon abonnement/ })).toBeNull();
  });

  it("offers the subscription again once the previous Stripe subscription is cancelled", async () => {
    mocks.legalPublisherConfigurationStatus.mockReturnValue({ ready: true, missing: [] });
    mocks.fetchAccessPlan.mockResolvedValue({
      plan: {
        plan: "decouverte",
        currentPeriodEnd: "2026-09-01T00:00:00.000Z",
        billing: { status: "cancelled", hasStripeCustomer: true, graceEndsAt: null },
      },
    });
    renderActions();

    expect(await screen.findByRole("button", { name: "Démarrer l’essai Analyse" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Gérer mon abonnement/ })).toBeNull();
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
    // Le paiement n'a pas démarré (le mock refuse) : rien n'est mesuré.
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(mocks.track).not.toHaveBeenCalled();
  });

  it("measures the start of a checkout once the payment address is returned", async () => {
    mocks.legalPublisherConfigurationStatus.mockReturnValue({ ready: true, missing: [] });
    // Une ancre du document : jsdom l'accepte sans quitter la page.
    mocks.startAnalyseCheckout.mockResolvedValue({ url: "#paiement" });
    renderActions();

    fireEvent.click(await screen.findByRole("button", { name: "Démarrer l’essai Analyse" }));
    await screen.findByRole("dialog");
    for (const consent of screen.getAllByRole("checkbox")) fireEvent.click(consent);
    fireEvent.click(screen.getByRole("button", { name: "Commander avec obligation de paiement" }));

    await waitFor(() => expect(mocks.track).toHaveBeenCalledWith("checkout_started"));
    expect(mocks.track).toHaveBeenCalledTimes(1);
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
      expect(mocks.navigate).toHaveBeenCalledWith(expect.stringMatching(/^\/login\?redirect=%2F/)),
    );
  });

  it("uses the offer read by the page instead of requesting it again", async () => {
    const reload = vi.fn();
    renderActions({
      offerSource: {
        offer: { status: "ready", configured: true, open: true, trialAvailable: true, label: null },
        reload,
      },
    });

    expect(await screen.findByRole("button", { name: "Démarrer l’essai Analyse" })).toBeTruthy();
    expect(mocks.fetchBillingOffer).not.toHaveBeenCalled();
  });
});

describe("BillingActions : offre en chargement, en erreur ou fermée", () => {
  it("never says the offer is closed while it is loading", async () => {
    mocks.fetchBillingOffer.mockReturnValue(new Promise(() => undefined));
    renderActions();

    expect(await screen.findByRole("status", { name: "Chargement de l’offre" })).toBeTruthy();
    expect(screen.queryByText(/Ouverture prochaine|temporairement indisponible/)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("separates a loading error from a closed offer and retries", async () => {
    mocks.legalPublisherConfigurationStatus.mockReturnValue({ ready: true, missing: [] });
    mocks.fetchBillingOffer.mockRejectedValueOnce(new Error("réseau"));
    renderActions();

    expect(await screen.findByText(/L’offre n’a pas pu être chargée/)).toBeTruthy();
    expect(screen.queryByText(/Ouverture prochaine/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    expect(await screen.findByRole("button", { name: "Démarrer l’essai Analyse" })).toBeTruthy();
    expect(mocks.fetchBillingOffer).toHaveBeenCalledTimes(2);
  });

  it("shows « Ouverture prochaine » when the price is not configured", async () => {
    mocks.legalPublisherConfigurationStatus.mockReturnValue({ ready: true, missing: [] });
    mocks.fetchBillingOffer.mockResolvedValue({ configured: false, trialDays: 7, label: "29 €" });
    renderActions();

    const closed = await screen.findByRole("button", { name: "Ouverture prochaine" });
    expect((closed as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/temporairement indisponible/)).toBeNull();
    expect(screen.getByRole("link", { name: "Voir les mentions légales" })).toBeTruthy();
  });

  it("shows « Ouverture prochaine » while the legal identity is incomplete", async () => {
    renderActions();
    expect(await screen.findByRole("button", { name: "Ouverture prochaine" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Démarrer l’essai/ })).toBeNull();
  });

  it("records an explicit opening request for a signed-in account and lets them withdraw it", async () => {
    renderActions();

    fireEvent.click(await screen.findByRole("button", { name: "Me prévenir de l’ouverture" }));
    await waitFor(() => expect(mocks.updateOfferOpeningNotification).toHaveBeenCalledWith(true));
    expect(await screen.findByText(/Votre demande est enregistrée/)).toBeTruthy();
    expect(mocks.track).toHaveBeenCalledWith("opening_notification_requested");

    mocks.updateOfferOpeningNotification.mockResolvedValue({
      notification: { requested: false, consentedAt: null },
    });
    fireEvent.click(screen.getByRole("button", { name: "Retirer ma demande" }));
    await waitFor(() =>
      expect(mocks.updateOfferOpeningNotification).toHaveBeenLastCalledWith(false),
    );
    expect(await screen.findByRole("button", { name: "Me prévenir de l’ouverture" })).toBeTruthy();
    // Retirer sa demande n'est pas une demande d'ouverture.
    expect(mocks.track).toHaveBeenCalledTimes(1);
  });

  it("shows the request as recorded when the account already asked", async () => {
    mocks.fetchOfferOpeningNotification.mockResolvedValue({
      notification: { requested: true, consentedAt: "2026-10-20T10:00:00.000Z" },
    });
    renderActions();

    expect(await screen.findByText(/Votre demande est enregistrée/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Me prévenir de l’ouverture" })).toBeNull();
  });

  it("sends a visitor to account creation instead of recording anything", async () => {
    mocks.user = null;
    renderActions();

    fireEvent.click(await screen.findByRole("button", { name: "Me prévenir de l’ouverture" }));
    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith("/login?mode=investor&redirect=%2Foffres"),
    );
    expect(mocks.updateOfferOpeningNotification).not.toHaveBeenCalled();
    expect(mocks.fetchOfferOpeningNotification).not.toHaveBeenCalled();
  });

  it("does not offer the opening request once the subscription is open", async () => {
    mocks.legalPublisherConfigurationStatus.mockReturnValue({ ready: true, missing: [] });
    renderActions();
    await screen.findByRole("button", { name: "Démarrer l’essai Analyse" });
    expect(screen.queryByRole("button", { name: "Me prévenir de l’ouverture" })).toBeNull();
  });
});

describe("BillingActions : retour de Stripe", () => {
  async function flush(ms = 0) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  beforeEach(() => {
    mocks.legalPublisherConfigurationStatus.mockReturnValue({ ready: true, missing: [] });
  });

  it("announces the payment, polls the plan every 2 s and confirms once it is Analyse", async () => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", "/offres?checkout=success&session_id=cs_test_1&x=1");
    mocks.fetchAccessPlan
      .mockResolvedValueOnce({ plan: { plan: "decouverte", currentPeriodEnd: null } })
      .mockResolvedValueOnce({ plan: { plan: "decouverte", currentPeriodEnd: null } })
      .mockResolvedValue({
        plan: { plan: "analyse", currentPeriodEnd: "2026-11-20T00:00:00.000Z" },
      });
    renderActions({ handleCheckoutReturn: true });
    await flush();

    expect(screen.getByText(/Paiement reçu, activation en cours/)).toBeTruthy();
    expect(window.location.search).toBe("?x=1");
    expect(mocks.fetchAccessPlan).toHaveBeenCalledTimes(1);

    await flush(1_999);
    expect(mocks.fetchAccessPlan).toHaveBeenCalledTimes(1);
    await flush(1);
    expect(mocks.fetchAccessPlan).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/activation en cours/)).toBeTruthy();

    await flush(2_000);
    expect(mocks.fetchAccessPlan).toHaveBeenCalledTimes(3);
    expect(screen.getByText(/Votre accès Analyse est activé/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Gérer mon abonnement Analyse" })).toBeTruthy();

    await flush(10_000);
    expect(mocks.fetchAccessPlan).toHaveBeenCalledTimes(3);
  });

  it("stops polling after 30 s and says the activation takes longer than expected", async () => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", "/offres?checkout=success&session_id=cs_test_1");
    renderActions({ handleCheckoutReturn: true });
    await flush();
    expect(window.location.search).toBe("");

    await flush(30_000);
    expect(screen.getByText(/L’activation prend plus de temps que prévu/)).toBeTruthy();
    const calls = mocks.fetchAccessPlan.mock.calls.length;
    expect(calls).toBeGreaterThan(10);
    expect(calls).toBeLessThanOrEqual(17);

    await flush(20_000);
    expect(mocks.fetchAccessPlan).toHaveBeenCalledTimes(calls);
  });

  it("keeps a neutral message when the payment was cancelled and cleans the address", async () => {
    window.history.replaceState(null, "", "/offres?checkout=cancelled");
    renderActions({ handleCheckoutReturn: true });

    expect(await screen.findByText(/Paiement annulé/)).toBeTruthy();
    expect(screen.queryByText(/Paiement reçu/)).toBeNull();
    expect(window.location.search).toBe("");
    await screen.findByRole("button", { name: "Démarrer l’essai Analyse" });
    expect(mocks.fetchAccessPlan).toHaveBeenCalledTimes(1);
    expect(mocks.track).toHaveBeenCalledWith("checkout_returned", { status: "cancelled" });
  });

  it("ignores the return parameters when the page does not ask for them", async () => {
    window.history.replaceState(null, "", "/offres?checkout=success");
    renderActions();

    await screen.findByRole("button", { name: "Démarrer l’essai Analyse" });
    expect(screen.queryByText(/Paiement reçu/)).toBeNull();
    expect(window.location.search).toBe("?checkout=success");
  });
});
