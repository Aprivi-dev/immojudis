"use client";

import Link from "next/link";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import Check from "lucide-react/dist/esm/icons/check.js";
import { OfferOpeningRequest } from "@/components/OfferOpeningRequestLazy";
import { useAnalysisCheckoutOpen } from "@/hooks/use-analysis-checkout-open";
import { useAuth } from "@/hooks/use-auth";
import { useLaunchOffer } from "@/hooks/use-launch-offer";
import { ANALYSIS_TRIAL_DAYS } from "@/lib/analysis-offer";
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

/**
 * Les deux offres, Découverte et Analyse. L'accueil met en avant l'inscription gratuite et l'essai
 * de 7 jours ; le tarif de l'offre Analyse n'y figure pas (décision du 25/10/2026) : il est sur
 * /offres, et présenté avant toute souscription.
 */
export function HomeOffers() {
  const checkoutOpen = useAnalysisCheckoutOpen();
  const { user } = useAuth();
  const launchOffer = useLaunchOffer().active;
  const signupPath = loginPathWithRedirect(undefined);

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
            {user ? null : (
              <Link href={signupPath} className={styles.secondaryLink}>
                Créer mon compte gratuit <ArrowRight aria-hidden="true" size={17} />
              </Link>
            )}
          </article>
          <article className={`${styles.plan} ${styles.planFeatured}`} data-reveal="">
            <h3>Analyse</h3>
            <p className={styles.planPrice}>
              {launchOffer ? `${ANALYSIS_TRIAL_DAYS} jours offerts` : "Sur abonnement"}
            </p>
            <ul>
              {analysisFeatures.map((feature) => (
                <li key={feature}>
                  <Check aria-hidden="true" size={15} />
                  <span>{feature}</span>
                </li>
              ))}
            </ul>
            {launchOffer && !user ? (
              <Link href={signupPath} className={styles.primaryLink}>
                Commencer l’essai gratuit <ArrowRight aria-hidden="true" size={17} />
              </Link>
            ) : !launchOffer && checkoutOpen === false ? (
              // Ni essai ni souscription : le bouton principal est la demande d'information.
              <OfferOpeningRequest primary className="mt-2" />
            ) : (
              <Link href="/offres" className={styles.primaryLink}>
                Découvrir Analyse <ArrowRight aria-hidden="true" size={17} />
              </Link>
            )}
            {launchOffer ? (
              <p className={styles.planFinePrint} data-testid="home-launch-offer">
                {launchOfferText(user ? "account" : "visitor")}
              </p>
            ) : checkoutOpen === true ? (
              <p className={styles.planFinePrint}>
                Abonnement mensuel, résiliable depuis votre compte. Tarif et conditions sur la page
                Offres.
              </p>
            ) : checkoutOpen === false ? (
              <p className={styles.planFinePrint}>Abonnement bientôt disponible.</p>
            ) : null}
          </article>
        </div>
      </div>
    </section>
  );
}
