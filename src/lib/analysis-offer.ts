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

export const DEFAULT_ANALYSIS_OFFER_LABEL = "29 € TTC / mois";

export function resolveAnalysisOfferLabel(
  value: string | undefined | null = process.env.NEXT_PUBLIC_ANALYSIS_OFFER_LABEL,
): string {
  const label = value?.trim();
  return label || DEFAULT_ANALYSIS_OFFER_LABEL;
}

/** A search engine shows about 160 characters of a meta description. */
export const OFFERS_DESCRIPTION_MAX_LENGTH = 160;

/**
 * Meta description of /offres. While the subscription cannot be bought (Stripe price or legal
 * identity missing) it states no price: a snippet that quotes "29 € par mois" for an offer that
 * is closed would be an advertisement for something that cannot be bought. Once open, it quotes
 * the public label (`resolveAnalysisOfferLabel`) when the sentence still fits in 160 characters.
 */
export function offersPageDescription({
  open,
  label = resolveAnalysisOfferLabel(),
}: {
  open: boolean;
  label?: string;
}): string {
  if (!open) {
    return "Découverte est gratuite. Analyse, l’offre d’aide à la décision (enchère plafond chiffrée, alertes, comparables), ouvrira prochainement.";
  }
  const candidates = [
    `Découverte est gratuite. Analyse chiffre votre enchère plafond, suit les nouvelles ventes avec des alertes et s’appuie sur des comparables : ${label}.`,
    `Découverte est gratuite. Analyse chiffre votre enchère plafond et suit les nouvelles ventes : ${label}.`,
  ];
  return (
    candidates.find((text) => text.length <= OFFERS_DESCRIPTION_MAX_LENGTH) ??
    "Découverte est gratuite. Analyse chiffre votre enchère plafond et suit les nouvelles ventes avec des alertes."
  );
}

const LABEL_AMOUNT = String.raw`\d+(?:[ \u00a0\u202f]\d{3})*(?:[.,]\d{1,2})?`;
const LABEL_CURRENCY = String.raw`(?:€|eur(?:os?)?)`;

/**
 * Every amount in euros written in a public price label ("29 € TTC / mois", "29,00 EUR",
 * "€29"), in cents. Keep in sync with `analysisOfferLabelAmountsCents` in
 * scripts/lib/launch-config.mjs (plain .mjs, tested against this module).
 */
export function analysisOfferLabelAmountsCents(label: string): number[] {
  const pattern = new RegExp(
    `(${LABEL_AMOUNT})\\s*${LABEL_CURRENCY}(?![\\p{L}])|${LABEL_CURRENCY}\\s*(${LABEL_AMOUNT})`,
    "giu",
  );
  return Array.from(label.matchAll(pattern), (match) => {
    const raw = (match[1] ?? match[2] ?? "").replace(/[ \u00a0\u202f]/g, "").replace(",", ".");
    return Math.round(Number.parseFloat(raw) * 100);
  });
}

/**
 * True when the label states the billed price (`ANALYSIS_RECURRING_PRICE_CENTS`) and no other
 * amount. The label (NEXT_PUBLIC_ANALYSIS_OFFER_LABEL) is only copy: the amount charged is
 * the Stripe Price, so a label that disagrees would advertise a price that is not billed.
 */
export function analysisOfferLabelMatchesPrice(
  label: string,
  priceCents: number = ANALYSIS_RECURRING_PRICE_CENTS,
): boolean {
  const amounts = analysisOfferLabelAmountsCents(label);
  return amounts.length > 0 && amounts.every((amount) => amount === priceCents);
}

export const ANALYSIS_TRIAL_LABEL = `Essai gratuit de ${ANALYSIS_TRIAL_DAYS} jours avec carte bancaire`;
export const ANALYSIS_RECURRING_LABEL = "Puis abonnement récurrent résiliable depuis Mon compte";
export const ANALYSIS_SUBSCRIPTION_ONLY_LABEL = "Abonnement récurrent résiliable depuis Mon compte";
