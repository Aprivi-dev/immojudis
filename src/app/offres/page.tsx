import type { Metadata } from "next";
import { offersPageDescription } from "@/lib/analysis-offer";
import { legalPublisherConfigurationStatus } from "@/lib/legal-documents";
import { OffersPage } from "./offers-page";

/**
 * The subscription is open when the Stripe price is configured on the server and the legal
 * identity is published: the same two conditions as `/api/billing/offer` and `useBillingOffer`.
 */
export function generateMetadata(): Metadata {
  const open =
    Boolean(process.env.STRIPE_ANALYSIS_PRICE_ID?.trim()) &&
    legalPublisherConfigurationStatus().ready;
  return {
    alternates: { canonical: "/offres" },
    title: "Offres Découverte et Analyse",
    description: offersPageDescription({ open }),
  };
}

export default function Page() {
  return <OffersPage />;
}
