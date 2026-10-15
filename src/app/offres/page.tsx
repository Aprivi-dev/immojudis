import type { Metadata } from "next";
import { BreadcrumbJsonLd } from "@/components/BreadcrumbJsonLd";
import { offersPageDescription } from "@/lib/analysis-offer";
import { legalPublisherConfigurationStatus } from "@/lib/legal-documents";
import { pageMetadata } from "@/lib/page-metadata";
import { OffersPage } from "./offers-page";

/**
 * The subscription is open when the Stripe price is configured on the server and the legal
 * identity is published: the same two conditions as `/api/billing/offer` and `useBillingOffer`.
 */
export function generateMetadata(): Metadata {
  const open =
    Boolean(process.env.STRIPE_ANALYSIS_PRICE_ID?.trim()) &&
    legalPublisherConfigurationStatus().ready;
  return pageMetadata({
    path: "/offres",
    title: "Offres Découverte et Analyse",
    description: offersPageDescription({ open }),
  });
}

export default function Page() {
  return (
    <>
      <BreadcrumbJsonLd trail={[{ name: "Offres", path: "/offres" }]} />
      <OffersPage />
    </>
  );
}
