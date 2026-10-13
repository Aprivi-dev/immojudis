import type { BillingSessionResponse } from "@/lib/billing";
import { OFFER_OPENING_CONSENT_VERSION } from "@/lib/offer-opening-consent";
import type { OfferOpeningNotificationResponse } from "@/lib/offer-opening-notification";
import type { PlanCode } from "@/lib/plans";
import type { PlanEntitlements } from "@/lib/property-reports";
import { authHeaders, readJson } from "@/lib/client-api-core";

export type BillingOfferResponse = {
  configured: boolean;
  trialDays: 7;
  trialAvailable?: boolean;
  label: string;
};

export async function fetchBillingOffer(): Promise<BillingOfferResponse> {
  // L'offre est publique : un visiteur sans session doit aussi savoir si la souscription est
  // ouverte (sinon la page afficherait « paiement indisponible » à tort).
  const headers = await authHeaders().catch((): HeadersInit => ({}));
  const response = await fetch("/api/billing/offer", {
    headers,
    cache: "no-store",
  });
  return readJson<BillingOfferResponse>(response);
}

export async function fetchAccessPlan(): Promise<{ plan: PlanEntitlements }> {
  const response = await fetch("/api/feature-entitlements?scope=plan", {
    headers: await authHeaders(),
    cache: "no-store",
  });
  return readJson<{ plan: PlanEntitlements }>(response);
}

export async function startAnalyseCheckout(args: {
  plan?: Exclude<PlanCode, "decouverte">;
  consent: {
    termsAccepted: true;
    termsVersion: string;
    privacyVersion: string;
    paymentObligationAcknowledged: true;
    immediatePerformanceRequested: true;
    withdrawalInformationAcknowledged: true;
  };
}): Promise<BillingSessionResponse> {
  const response = await fetch("/api/billing/checkout", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify({ plan: args.plan ?? "analyse", consent: args.consent }),
  });

  return readJson<BillingSessionResponse>(response);
}

export async function openBillingPortal(): Promise<BillingSessionResponse> {
  const response = await fetch("/api/billing/portal", {
    method: "POST",
    headers: await authHeaders(),
  });

  return readJson<BillingSessionResponse>(response);
}

/**
 * Opens the cancellation form of the Stripe portal directly.  The subscription is resolved
 * by the server from the signed-in user's own row: only the intent is sent.
 */
export async function openSubscriptionCancellation(): Promise<BillingSessionResponse> {
  const response = await fetch("/api/billing/portal", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ intent: "cancel" }),
  });

  return readJson<BillingSessionResponse>(response);
}

export async function fetchOfferOpeningNotification(): Promise<OfferOpeningNotificationResponse> {
  const response = await fetch("/api/billing/opening-notification", {
    headers: await authHeaders(),
    cache: "no-store",
  });
  return readJson<OfferOpeningNotificationResponse>(response);
}

/** Explicit opt-in (or withdrawal) to be told once when subscriptions open. */
export async function updateOfferOpeningNotification(
  enabled: boolean,
): Promise<OfferOpeningNotificationResponse> {
  const response = await fetch("/api/billing/opening-notification", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(
      enabled ? { enabled, consentTextVersion: OFFER_OPENING_CONSENT_VERSION } : { enabled },
    ),
  });
  return readJson<OfferOpeningNotificationResponse>(response);
}
