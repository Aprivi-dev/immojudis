import type { Metadata } from "next";
import { BreadcrumbJsonLd } from "@/components/BreadcrumbJsonLd";
import { LaunchOfferProvider } from "@/components/LaunchOfferProvider";
import { offersPageDescription } from "@/lib/analysis-offer";
import { analysisCheckoutReadiness } from "@/lib/analysis-checkout-readiness";
import { openFeeRegimesFromEnv } from "@/lib/fee-regime.server";
import { readLaunchOfferState } from "@/lib/launch-offer.server";
import { pageMetadata } from "@/lib/page-metadata";
import { OffersPage } from "./offers-page";

// L'état de l'essai à l'inscription est lu dans la base avec la page : générée à l'avance puis
// rafraîchie par Next.js chaque minute (la coupure de l'essai se voit en une minute ou deux, comme
// avec `/api/launch-offer`). Next.js veut ici un littéral.
export const revalidate = 60;

/**
 * The subscription is open when `analysisCheckoutReadiness` says so: the same definition as the
 * checkout and `/api/billing/offer`. Le titre et la description ne lisent pas l'essai à
 * l'inscription : la page, elle, le lit (voir `revalidate`).
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

export default async function Page() {
  const launchOffer = await readLaunchOfferState();
  // Une lecture en erreur (`degraded`) n'est pas un « essai fermé » : état non lu, la page affiche
  // des textes vrais dans les deux cas.
  const trialOpen = launchOffer.degraded ? undefined : launchOffer.active;
  return (
    <>
      <BreadcrumbJsonLd trail={[{ name: "Offres", path: "/offres" }]} />
      <LaunchOfferProvider initialActive={trialOpen}>
        <OffersPage
          openFeeRegimes={openFeeRegimesFromEnv()}
          // La souscription ouverte ou non est connue du serveur (même définition que le checkout) :
          // « tarif prévu, pas encore souscriptible » figure dans le HTML, pas après un chargement.
          initialSubscriptionOpen={analysisCheckoutReadiness().open}
        />
      </LaunchOfferProvider>
    </>
  );
}
