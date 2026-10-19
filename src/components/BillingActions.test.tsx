// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LAUNCH_OFFER_ACCOUNT_TEXT, LAUNCH_OFFER_VISITOR_TEXT } from "@/lib/launch-offer";
import { BillingActions } from "./BillingActions";

const mocks = vi.hoisted(() => ({
  user: { id: "investor" } as { id: string } | null,
  loading: false,
  navigate: vi.fn(),
  fetchAccessPlan: vi.fn(),
  fetchBillingOffer: vi.fn(),
  fetchOfferOpeningNotification: vi.fn(),
  updateOfferOpeningNotification: vi.fn(),
  updateOfferOpeningSurvey: vi.fn(),
  launch: { active: false, pending: false },
  startAnalyseCheckout: vi.fn(),
  openBillingPortal: vi.fn(),
  openSubscriptionCancellation: vi.fn(),
  legalPublisherConfigurationStatus: vi.fn(),
  toastError: vi.fn(),
  track: vi.fn(),
}));
vi.mock("@/lib/product-events", () => ({ trackProductEvent: mocks.track }));

vi.mock("@/hooks/use-launch-offer", () => ({ useLaunchOffer: () => mocks.launch }));

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
  updateOfferOpeningSurvey: mocks.updateOfferOpeningSurvey,
  startAnalyseCheckout: mocks.startAnalyseCheckout,
  openBillingPortal: mocks.openBillingPortal,
  openSubscriptionCancellation: mocks.openSubscriptionCancellation,
}));

vi.mock("@/lib/legal-documents", () => ({
  LEGAL_DOCUMENTS: {
    terms: { version: "terms-v1" },
    privacy: { version: "privacy-v1" },
  },
  legalPublisherConfigurationStatus: mocks.legalPublisherConfigurationStatus,
}));

vi.mock("@/lib/toast", () => ({ toast: { error: mocks.toastError } }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

beforeEach(() => {
  mocks.user = { id: "investor" };
  mocks.loading = false;
  mocks.launch = { active: false, pending: false };
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
  mocks.updateOfferOpeningSurvey.mockResolvedValue({
    notification: { requested: true, consentedAt: "2026-10-20T10:00:00.000Z" },
  });
  mocks.startAnalyseCheckout.mockRejectedValue(new Error("test checkout arrêté"));
  mocks.openBillingPortal.mockRejectedValue(new Error("test portail arrêté"));
  mocks.openSubscriptionCancellation.mockRejectedValue(new Error("test résiliation arrêtée"));
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

  it.each(["trialing", "active", "past_due"] as const)(
    "shows « Résilier mon abonnement » next to the portal for a %s subscriber and opens the cancellation flow",
    async (status) => {
      mocks.fetchAccessPlan.mockResolvedValue({
        plan: {
          plan: "analyse",
          currentPeriodEnd: "2026-12-01T00:00:00.000Z",
          billing: { status, hasStripeCustomer: true, graceEndsAt: null },
        },
      });
      renderActions();

      expect(
        await screen.findByRole("button", { name: "Gérer mon abonnement Analyse" }),
      ).toBeTruthy();
      const cancel = await screen.findByRole("button", { name: "Résilier mon abonnement" });
      expect((cancel as HTMLButtonElement).disabled).toBe(false);

      fireEvent.click(cancel);
      await waitFor(() => expect(mocks.openSubscriptionCancellation).toHaveBeenCalledTimes(1));
      expect(mocks.openBillingPortal).not.toHaveBeenCalled();
      await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    },
  );

  it("hides « Résilier mon abonnement » without a live Stripe subscription", async () => {
    mocks.fetchAccessPlan.mockResolvedValue({
      plan: { plan: "analyse", currentPeriodEnd: "2026-12-01T00:00:00.000Z" },
    });
    renderActions();
    await screen.findByRole("button", { name: "Gérer mon abonnement Analyse" });
    expect(screen.queryByRole("button", { name: "Résilier mon abonnement" })).toBeNull();
  });

  it("hides « Résilier mon abonnement » once the subscription is paused", async () => {
    mocks.fetchAccessPlan.mockResolvedValue({
      plan: {
        plan: "decouverte",
        currentPeriodEnd: "2026-12-01T00:00:00.000Z",
        billing: { status: "paused", hasStripeCustomer: true, graceEndsAt: null },
      },
    });
    renderActions();
    await screen.findByRole("button", { name: "Gérer mon abonnement" });
    expect(screen.queryByRole("button", { name: "Résilier mon abonnement" })).toBeNull();
  });

  it("shows the end of the grace period, not the start of the unpaid period, when a renewal failed", async () => {
    mocks.fetchAccessPlan.mockResolvedValue({
      plan: {
        plan: "analyse",
        // Start of the unpaid period, already past: this is what is stored for past_due.
        currentPeriodEnd: "2026-10-01T12:00:00.000Z",
        billing: {
          status: "past_due",
          hasStripeCustomer: true,
          graceEndsAt: "2026-10-08T12:00:00.000Z",
        },
      },
    });
    renderActions();

    const access = await screen.findByRole("button", { name: /Actif jusqu/ });
    expect(access.textContent).toContain("08");
    expect(access.textContent).not.toContain("01 oct");
  });

  it("computes the grace end like plans.ts when the response carries no graceEndsAt", async () => {
    mocks.fetchAccessPlan.mockResolvedValue({
      plan: {
        plan: "analyse",
        currentPeriodEnd: "2026-10-01T12:00:00.000Z",
        billing: { status: "past_due", hasStripeCustomer: true, graceEndsAt: null },
      },
    });
    renderActions();

    const access = await screen.findByRole("button", { name: /Actif jusqu/ });
    expect(access.textContent).toContain("08");
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

    // Motif « offre » : le bandeau de la page de connexion explique le détour.
    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith(
        expect.stringMatching(/^\/login\?redirect=%2F.*&mode=investor&reason=offre$/),
      ),
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

  it("offre fermée : le bouton principal est « Me prévenir de l’ouverture » et le tarif est prévu, pas à payer", async () => {
    mocks.legalPublisherConfigurationStatus.mockReturnValue({ ready: true, missing: [] });
    mocks.fetchBillingOffer.mockResolvedValue({
      configured: false,
      trialDays: 7,
      label: "59 € TTC / mois",
    });
    renderActions();

    expect(await screen.findByRole("button", { name: "Me prévenir de l’ouverture" })).toBeTruthy();
    expect(
      screen.getByText("Tarif prévu : 59 € TTC / mois. Pas encore souscriptible."),
    ).toBeTruthy();
    // Plus de bouton grisé « Ouverture prochaine » : aucun achat n'est proposé.
    expect(screen.queryByRole("button", { name: "Ouverture prochaine" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Démarrer l’essai|Souscrire/ })).toBeNull();
    expect(screen.queryByText(/temporairement indisponible/)).toBeNull();
    expect(screen.getByRole("link", { name: "Voir les mentions légales" })).toBeTruthy();
  });

  it("offre fermée aussi tant que l'identité légale est incomplète", async () => {
    renderActions();
    expect(await screen.findByRole("button", { name: "Me prévenir de l’ouverture" })).toBeTruthy();
    expect(screen.getByText(/Pas encore souscriptible\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Démarrer l’essai/ })).toBeNull();
  });

  it("records an explicit opening request for a signed-in account and lets them withdraw it", async () => {
    renderActions();

    const requestButton = await screen.findByRole("button", { name: "Me prévenir de l’ouverture" });
    // Avant le clic, on décrit la demande ; on n'annonce pas qu'elle est enregistrée.
    expect(screen.getByText(/En cliquant, vous demandez à recevoir un seul email/)).toBeTruthy();
    expect(screen.queryByText(/Votre demande est enregistrée/)).toBeNull();
    fireEvent.click(requestButton);
    await waitFor(() => expect(mocks.updateOfferOpeningNotification).toHaveBeenCalledWith(true));
    expect(await screen.findByText(/Votre demande est enregistrée/)).toBeTruthy();
    expect(
      screen.getByText(/nous vous écrirons une seule fois à l’ouverture de l’offre Analyse/),
    ).toBeTruthy();
    expect(screen.queryByText(/un email vous préviendra/)).toBeNull();
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
    // Motif « ouverture » : la demande est enregistrée au retour, une fois le compte créé.
    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith(
        "/login?redirect=%2Foffres%3Fdemande%3Douverture&mode=investor&reason=ouverture",
      ),
    );
    expect(mocks.updateOfferOpeningNotification).not.toHaveBeenCalled();
    expect(mocks.fetchOfferOpeningNotification).not.toHaveBeenCalled();
  });

  it("explique au visiteur ce qu'il demande avant le détour par la création du compte", async () => {
    mocks.user = null;
    renderActions();
    await screen.findByRole("button", { name: "Me prévenir de l’ouverture" });
    expect(screen.getByText(/En cliquant, vous demandez à recevoir un seul email/)).toBeTruthy();
    expect(screen.getByText(/Un compte gratuit est nécessaire/)).toBeTruthy();
  });

  it("enregistre la demande au retour de la connexion, puis retire le paramètre de l'adresse", async () => {
    window.history.replaceState(null, "", "/offres?demande=ouverture");
    renderActions();

    await waitFor(() => expect(mocks.updateOfferOpeningNotification).toHaveBeenCalledWith(true));
    expect(await screen.findByText(/Votre demande est enregistrée/)).toBeTruthy();
    expect(window.location.search).toBe("");
    expect(mocks.track).toHaveBeenCalledWith("opening_notification_requested");
  });

  it("n'enregistre rien au retour si le compte avait déjà demandé", async () => {
    mocks.fetchOfferOpeningNotification.mockResolvedValue({
      notification: { requested: true, consentedAt: "2026-10-20T10:00:00.000Z" },
    });
    window.history.replaceState(null, "", "/offres?demande=ouverture");
    renderActions();

    expect(await screen.findByText(/Votre demande est enregistrée/)).toBeTruthy();
    expect(mocks.updateOfferOpeningNotification).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });

  it("n'enregistre rien sans le paramètre de retour", async () => {
    window.history.replaceState(null, "", "/offres");
    renderActions();
    await screen.findByRole("button", { name: "Me prévenir de l’ouverture" });
    expect(mocks.updateOfferOpeningNotification).not.toHaveBeenCalled();
  });

  it("propose les questions facultatives une fois la demande enregistrée, case d'entretien décochée", async () => {
    mocks.fetchOfferOpeningNotification.mockResolvedValue({
      notification: { requested: true, consentedAt: "2026-10-20T10:00:00.000Z", survey: null },
    });
    renderActions();

    const form = await screen.findByTestId("offer-opening-survey");
    expect(form.textContent).toContain("toutes facultatives");
    const interview = screen.getByRole("checkbox", {
      name: /J’accepte un entretien de 20 minutes/,
    }) as HTMLInputElement;
    expect(interview.checked).toBe(false);
    expect(screen.getByRole("combobox")).toBeTruthy();

    // Tout peut rester vide : l'envoi ne bloque sur rien.
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer mes réponses" }));
    await waitFor(() =>
      expect(mocks.updateOfferOpeningSurvey).toHaveBeenCalledWith({
        profile: null,
        salesPerMonth: null,
        priceTooExpensiveEur: null,
        priceCheapEur: null,
        interviewAccepted: false,
      }),
    );
  });

  it("envoie les réponses saisies et l'accord à l'entretien", async () => {
    mocks.fetchOfferOpeningNotification.mockResolvedValue({
      notification: { requested: true, consentedAt: "2026-10-20T10:00:00.000Z", survey: null },
    });
    renderActions();
    await screen.findByTestId("offer-opening-survey");

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "avocat" } });
    fireEvent.change(screen.getByLabelText(/Combien de ventes étudiez-vous par mois/), {
      target: { value: "12" },
    });
    fireEvent.change(screen.getByLabelText(/trop chère/), { target: { value: "60" } });
    fireEvent.change(screen.getByLabelText(/bon marché/), { target: { value: "15" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /entretien de 20 minutes/ }));
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer mes réponses" }));

    await waitFor(() =>
      expect(mocks.updateOfferOpeningSurvey).toHaveBeenCalledWith({
        profile: "avocat",
        salesPerMonth: 12,
        priceTooExpensiveEur: 60,
        priceCheapEur: 15,
        interviewAccepted: true,
      }),
    );
    expect(await screen.findByText("Réponses enregistrées.")).toBeTruthy();
  });

  it("ne montre pas les questions à qui n'a pas encore demandé à être prévenu", async () => {
    renderActions();
    await screen.findByRole("button", { name: "Me prévenir de l’ouverture" });
    expect(screen.queryByTestId("offer-opening-survey")).toBeNull();
  });

  it("does not offer the opening request once the subscription is open", async () => {
    mocks.legalPublisherConfigurationStatus.mockReturnValue({ ready: true, missing: [] });
    renderActions();
    await screen.findByRole("button", { name: "Démarrer l’essai Analyse" });
    expect(screen.queryByRole("button", { name: "Me prévenir de l’ouverture" })).toBeNull();
  });
});

describe("BillingActions : offre de lancement", () => {
  it("ne propose ni achat ni portail à un compte gratuit surclassé, et rappelle la mention", async () => {
    mocks.launch = { active: true, pending: false };
    mocks.legalPublisherConfigurationStatus.mockReturnValue({ ready: true, missing: [] });
    mocks.fetchAccessPlan.mockResolvedValue({
      plan: { plan: "analyse", currentPeriodEnd: null, launchOffer: true },
    });
    renderActions();

    const notice = await screen.findByTestId("launch-offer-notice");
    expect(notice.textContent).toBe(LAUNCH_OFFER_ACCOUNT_TEXT);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/Gérer mon abonnement|Résilier/)).toBeNull();
    expect(mocks.startAnalyseCheckout).not.toHaveBeenCalled();
    expect(mocks.openBillingPortal).not.toHaveBeenCalled();
  });

  it("laisse le portail à un ancien abonné dont le paiement a échoué, même pendant l'offre", async () => {
    mocks.fetchAccessPlan.mockResolvedValue({
      plan: {
        plan: "analyse",
        currentPeriodEnd: "2026-08-01T00:00:00.000Z",
        launchOffer: true,
        billing: { status: "past_due", hasStripeCustomer: true, graceEndsAt: null },
      },
    });
    renderActions();
    expect(await screen.findByRole("button", { name: "Gérer mon abonnement" })).toBeTruthy();
    expect(screen.queryByTestId("launch-offer-notice")).toBeNull();
  });

  it("montre au visiteur la mention de l'offre avec un lien de création de compte, sans achat", async () => {
    mocks.user = null;
    mocks.launch = { active: true, pending: false };
    mocks.legalPublisherConfigurationStatus.mockReturnValue({ ready: true, missing: [] });
    renderActions();

    const notice = await screen.findByTestId("launch-offer-notice");
    expect(notice.textContent).toContain(LAUNCH_OFFER_VISITOR_TEXT);
    expect(
      screen.getByRole("link", { name: "Créer mon compte gratuit" }).getAttribute("href"),
    ).toMatch(/^\/login\?redirect=%2Fsales&mode=investor&reason=offre$/);
    expect(screen.queryByRole("button", { name: /Démarrer l’essai|Souscrire/ })).toBeNull();
  });

  it("attend l'état de l'offre avant de montrer le moindre bouton à un visiteur", async () => {
    mocks.user = null;
    mocks.launch = { active: false, pending: true };
    renderActions();
    expect(await screen.findByRole("status", { name: "Chargement de l’offre" })).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/Pas encore souscriptible/)).toBeNull();
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
