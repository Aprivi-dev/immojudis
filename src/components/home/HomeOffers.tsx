"use client";

import Link from "next/link";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import Check from "lucide-react/dist/esm/icons/check.js";
import { OfferOpeningRequest } from "@/components/OfferOpeningRequestLazy";
import { useAnalysisCheckoutOpen } from "@/hooks/use-analysis-checkout-open";
import { useAuth } from "@/hooks/use-auth";
import { useLaunchOffer } from "@/hooks/use-launch-offer";
import { ANALYSIS_TRIAL_DAYS, resolveAnalysisOfferLabel } from "@/lib/analysis-offer";
import { launchOfferText } from "@/lib/launch-offer";
import { loginPathWithRedirect } from "@/lib/navigation";
import { PLAN_LIMITS } from "@/lib/plans";
import { MONTHLY_SALE_UNLOCKS, UNLOCK_HIGHLIGHTS_TEXT } from "@/lib/sale-unlocks";
import styles from "./HomePage.module.css";

const discoveryFeatures = [
  "Accès aux annonces",
  "Informations essentielles",
  `${MONTHLY_SALE_UNLOCKS} ventes débloquées par mois : ${UNLOCK_HIGHLIGHTS_TEXT}`,
  `Jusqu’à ${PLAN_LIMITS.decouverte.favoriteSales} favoris`,
] as const;

const analysisFeatures = [
  "Enchère plafond et travaux",
  "Estimation et comparables",
  "Pièces et risques, selon la vente",
  "Simulation ajustable",
] as const;

/** Les deux offres, Découverte et Analyse, avec l'état réel de la souscription. */
export function HomeOffers() {
  const analysisPrice = resolveAnalysisOfferLabel();
  const checkoutOpen = useAnalysisCheckoutOpen();
  const { user } = useAuth();
  const launchOffer = useLaunchOffer().active;

  return (
    <section className={styles.offers} aria-labelledby="offers-title">
      <div className={styles.container}>
        <div className={styles.sectionHead} data-reveal="">
          <p className={styles.eyebrow}>Nos offres</p>
          <h2 id="offers-title">Explorez librement. Analysez en profondeur.</h2>
        </div>
        <div className={styles.plans}>
          <article className={styles.plan} data-reveal="">
            <h3>Découverte</h3>
            <p className={styles.planPrice}>0 €</p>
            <ul>
              {discoveryFeatures.map((feature) => (
                <li key={feature}>
                  <Check aria-hidden="true" size={15} />
                  <span>{feature}</span>
                </li>
              ))}
            </ul>
            <Link href={loginPathWithRedirect(undefined)} className={styles.secondaryLink}>
              Créer mon compte gratuit <ArrowRight aria-hidden="true" size={17} />
            </Link>
            {launchOffer ? (
              <p className={styles.planFinePrint} data-testid="home-launch-offer">
                {launchOfferText(user ? "account" : "visitor")}
              </p>
            ) : null}
          </article>
          <article className={`${styles.plan} ${styles.planFeatured}`} data-reveal="">
            <h3>Analyse</h3>
            <p className={styles.planPrice}>{analysisPrice}</p>
            <ul>
              {analysisFeatures.map((feature) => (
                <li key={feature}>
                  <Check aria-hidden="true" size={15} />
                  <span>{feature}</span>
                </li>
              ))}
            </ul>
            {!launchOffer && checkoutOpen === false ? (
              // Offre fermée : le bouton principal est la demande d'information.
              <OfferOpeningRequest primary className="mt-2" />
            ) : (
              <Link href="/offres" className={styles.primaryLink}>
                Découvrir Analyse <ArrowRight aria-hidden="true" size={17} />
              </Link>
            )}
            {launchOffer ? (
              <p className={styles.planFinePrint}>
                Inclus avec un compte gratuit pendant l’offre de lancement. Tarif prévu :{" "}
                {analysisPrice}. Pas encore souscriptible.
              </p>
            ) : checkoutOpen === true ? (
              <p className={styles.planFinePrint}>
                Essai de {ANALYSIS_TRIAL_DAYS} jours avec carte bancaire, puis abonnement récurrent.
                Résiliable depuis votre compte.
              </p>
            ) : checkoutOpen === false ? (
              <p className={styles.planFinePrint}>
                Tarif prévu : {analysisPrice}. Pas encore souscriptible.
              </p>
            ) : null}
          </article>
        </div>
      </div>
    </section>
  );
}
