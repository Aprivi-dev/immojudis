/**
 * Copy shared by the server checkout contract and the public offer UI.
 *
 * The server accepts only the approved recurring Stripe Price below. The
 * public label is configurable for deployment copy and defaults to that same
 * commercial contract.
 */
export const ANALYSIS_TRIAL_DAYS = 7 as const;
/** Approved local commercial contract: 29 EUR TTC billed every month. */
export const ANALYSIS_RECURRING_PRICE_CENTS = 2_900 as const;
export const ANALYSIS_RECURRING_CURRENCY = "eur" as const;
export const ANALYSIS_RECURRING_INTERVAL = "month" as const;
export const ANALYSIS_RECURRING_INTERVAL_COUNT = 1 as const;
// Stripe accepts a Checkout expiry from 30 minutes onward. The extra minute
// absorbs request latency while keeping the reservation and Session windows aligned.
export const ANALYSIS_CHECKOUT_EXPIRY_MINUTES = 31 as const;
export const ANALYSIS_OFFER_CODE = "analyse_subscription_trial_7_days" as const;
export const ANALYSIS_BILLING_MODEL = "subscription_trial_7_days" as const;
export const ANALYSIS_SUBSCRIPTION_OFFER_CODE = "analyse_subscription_recurring" as const;
export const ANALYSIS_SUBSCRIPTION_BILLING_MODEL = "subscription_recurring" as const;

export const DEFAULT_ANALYSIS_OFFER_LABEL = "29 € / mois";

export function resolveAnalysisOfferLabel(
  value: string | undefined | null = process.env.NEXT_PUBLIC_ANALYSIS_OFFER_LABEL,
): string {
  const label = value?.trim();
  return label || DEFAULT_ANALYSIS_OFFER_LABEL;
}

export const ANALYSIS_TRIAL_LABEL = `Essai gratuit de ${ANALYSIS_TRIAL_DAYS} jours avec carte bancaire`;
export const ANALYSIS_RECURRING_LABEL =
  "Puis abonnement récurrent résiliable depuis le portail Stripe";
export const ANALYSIS_SUBSCRIPTION_ONLY_LABEL =
  "Abonnement récurrent résiliable depuis le portail Stripe";
