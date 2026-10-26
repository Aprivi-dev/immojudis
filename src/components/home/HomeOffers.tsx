"use client";

import Link from "next/link";
import { OfferOpeningRequest } from "@/components/OfferOpeningRequestLazy";
import { useAnalysisCheckoutOpen } from "@/hooks/use-analysis-checkout-open";
import { useAuth } from "@/hooks/use-auth";
import { useLaunchOffer } from "@/hooks/use-launch-offer";
import { ANALYSIS_TRIAL_DAYS } from "@/lib/analysis-offer";
import { launchOfferText } from "@/lib/launch-offer";
import { loginPathWithRedirect } from "@/lib/navigation";
import { PLAN_LIMITS } from "@/lib/plans";
import { MONTHLY_SALE_UNLOCKS, UNLOCK_HIGHLIGHTS_TEXT } from "@/lib/sale-unlocks";
import { ArrowRight, Check } from "./HomeIcons";
import styles from "./HomePage.module.css";

const discoveryFeatures = (unlockHighlights: string) =>
  [
    "Accès aux annonces, sur la carte et en liste",
    "Informations essentielles de chaque vente",
    `${MONTHLY_SALE_UNLOCKS} ventes débloquées par mois : ${unlockHighlights}`,
    `Jusqu’à ${PLAN_LIMITS.decouverte.favoriteSales} favoris`,
  ] as const;

/** Le terme par défaut de la carte Analyse : les régimes ouverts par défaut le justifient. */
export const DEFAULT_HOME_CEILING_FEATURE = "Enchère plafond et travaux";

const analysisFeatures = (ceilingFeature: string) =>
  [
    ceilingFeature,
    "Estimation et comparables",
    "Pièces et risques, selon la vente",
    "Simulation ajustable",
  ] as const;

function Features({ items }: { items: readonly string[] }) {
  return (
    <ul>
      {items.map((feature) => (
        <li key={feature}>
          <Check aria-hidden size={16} />
          <span>{feature}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Les deux offres, Découverte et Analyse. L'accueil met en avant l'inscription gratuite et l'essai
 * de 7 jours ; le tarif de l'offre Analyse n'y figure pas (décision du 25/10/2026) : il est sur
 * /offres, et présenté avant toute souscription. Une seule action d'inscription, sous les deux
 * cartes, pour un visiteur ; la carte Analyse garde son lien (« Découvrir Analyse ») ou la demande
 * d'ouverture quand ni essai ni souscription ne sont ouverts.
 */
export function HomeOffers({
  unlockHighlights = UNLOCK_HIGHLIGHTS_TEXT,
  ceilingFeature = DEFAULT_HOME_CEILING_FEATURE,
}: {
  /**
   * Ce qu'un déblocage ouvre, composé par la page serveur avec les régimes de frais ouverts
   * (`unlockHighlightsText`) ; absent : le texte des régimes ouverts par défaut.
   */
  unlockHighlights?: string;
  /** Première ligne de la carte Analyse (« Enchère plafond et travaux »), composée de même. */
  ceilingFeature?: string;
} = {}) {
  const checkoutOpen = useAnalysisCheckoutOpen();
  const { user } = useAuth();
  const trialOpen = useLaunchOffer().active;

  return (
    <section
      id="offres"
      className={`${styles.section} ${styles.sectionFlush}`}
      aria-labelledby="offers-title"
    >
      <div className={styles.container}>
        <div className={styles.head} data-reveal="">
          <p className={styles.eyebrow}>Nos offres</p>
          <h2 id="offers-title" className={styles.h2}>
            {trialOpen
              ? `Explorez gratuitement. Analysez ${ANALYSIS_TRIAL_DAYS} jours sans payer.`
              : "Explorez gratuitement. Analysez en profondeur."}
          </h2>
        </div>
        <div className={styles.plans}>
          <article className={styles.plan} data-reveal="">
            <div className={styles.planHead}>
              <h3>Découverte</h3>
              <p className={styles.planPrice}>0 €</p>
            </div>
            <Features items={discoveryFeatures(unlockHighlights)} />
            <p className={styles.planFinePrint}>Gratuit, sans limite de durée.</p>
          </article>
          <article className={`${styles.plan} ${styles.planFeatured}`} data-reveal="">
            <div className={styles.planHead}>
              <h3>Analyse</h3>
              <p className={styles.planPrice}>
                {trialOpen ? `${ANALYSIS_TRIAL_DAYS} jours offerts` : "Sur abonnement"}
              </p>
            </div>
            <Features items={analysisFeatures(ceilingFeature)} />
            {trialOpen ? (
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
            {!trialOpen && checkoutOpen === false ? (
              // Ni essai ni souscription : la carte propose la demande d'information.
              <OfferOpeningRequest primary className="mt-2" />
            ) : trialOpen && !user ? null : (
              <Link href="/offres" className={`${styles.textLink} ${styles.planAction}`}>
                Découvrir Analyse <ArrowRight aria-hidden size={16} />
              </Link>
            )}
          </article>
        </div>
        {user ? null : (
          <div className={styles.plansCta} data-reveal="">
            <Link href={loginPathWithRedirect(undefined)} className={styles.button}>
              Créer mon compte gratuit <ArrowRight aria-hidden size={20} />
            </Link>
            {trialOpen ? (
              <span className={styles.ctaNote}>Rien n’est prélevé à la fin de l’essai.</span>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}
