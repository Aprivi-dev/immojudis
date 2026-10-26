import type { Metadata } from "next";
import { BreadcrumbJsonLd } from "@/components/BreadcrumbJsonLd";
import { offersPageDescription } from "@/lib/analysis-offer";
import { analysisCheckoutReadiness } from "@/lib/analysis-checkout-readiness";
import { openFeeRegimesFromEnv } from "@/lib/fee-regime.server";
import { pageMetadata } from "@/lib/page-metadata";
import { OffersPage } from "./offers-page";

/**
 * The subscription is open when `analysisCheckoutReadiness` says so: the same definition as the
 * checkout and `/api/billing/offer`. L'offre de lancement n'y est pas lue (la page reste statique) ;
 * elle se coupe avant l'ouverture des paiements.
 */
export function generateMetadata(): Metadata {
  const open = analysisCheckoutReadiness().open;
  return pageMetadata({
    path: "/offres",
    title: "Offres Découverte et Analyse",
    // Le terme du plafond suit l'interrupteur par régime (`CEILING_FEE_REGIMES_OPEN`).
    description: offersPageDescription({ open, regimes: openFeeRegimesFromEnv() }),
  });
}

export default function Page() {
  return (
    <>
      <BreadcrumbJsonLd trail={[{ name: "Offres", path: "/offres" }]} />
      <OffersPage openFeeRegimes={openFeeRegimesFromEnv()} />
    </>
  );
}
