"use client";

import { notaryAndStatePilotsEnabled } from "@/lib/sale-types";
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
import styles from "./HomeDiscovery.module.css";

const methodSteps = [
  {
    number: "01",
    title: "Repérez une vente",
    description:
      "Choisissez votre secteur, puis repérez la mise à prix, la date d’audience et le type de vente.",
  },
  {
    number: "02",
    title: "Étudiez et visitez",
    description:
      "Lisez le cahier des conditions de vente (le document qui fixe les règles de la vente) et les pièces, puis participez aux visites pour comprendre l’état du bien et son occupation.",
  },
  {
    number: "03",
    title: "Fixez votre enchère plafond",
    description:
      "Additionnez le prix, les frais et les travaux, préparez votre financement, puis fixez la limite à ne pas dépasser avant l’audience.",
  },
  {
    number: "04",
    title: "Enchérissez et finalisez",
    description:
      "Au tribunal, un avocat porte vos enchères. Si vous remportez la vente, payez le prix et les frais dans les délais prévus.",
  },
] as const;

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
 * « 59 € TTC / mois » → montant en grand, unité en petit, sur une seule ligne : le libellé public
 * (variable d'environnement) ne passe plus à la ligne au milieu du prix. Sans « € », tout reste en
 * grand.
 */
export function splitPriceLabel(label: string): { amount: string; unit: string } {
  const end = label.indexOf("€");
  if (end < 0) return { amount: label.trim(), unit: "" };
  return { amount: label.slice(0, end + 1).trim(), unit: label.slice(end + 1).trim() };
}

function PlanPrice({ label }: { label: string }) {
  const { amount, unit } = splitPriceLabel(label);
  return (
    <>
      <span className={styles.planAmount}>{amount}</span>
      {unit ? <span className={styles.planUnit}> {unit}</span> : null}
    </>
  );
}

export function HomeDiscovery() {
  const analysisPrice = resolveAnalysisOfferLabel();
  const checkoutOpen = useAnalysisCheckoutOpen();
  const { user } = useAuth();
  const launchOffer = useLaunchOffer().active;

  return (
    <div className={styles.root}>
      <section
        id="comprendre-les-encheres"
        className={styles.method}
        aria-labelledby="method-title"
      >
        <div className={styles.container}>
          <div className={styles.methodHeader}>
            <div>
              <p className={styles.eyebrow}>Les enchères, simplement</p>
              <h2 id="method-title">
                Acheter aux enchères,
                <br />
                <em>étape par étape.</em>
              </h2>
            </div>
            <p className={styles.methodIntro}>
              Un achat aux enchères se prépare. Voici les quatre grandes étapes pour avancer, du
              choix du bien à la vente.
            </p>
          </div>
          <ol className={styles.steps}>
            {methodSteps.map((step) => (
              <li className={styles.step} key={step.number}>
                <div className={styles.stepMarker} aria-hidden="true">
                  <span className={styles.stepNumber}>{step.number}</span>
                  <span className={styles.stepLine} />
                </div>
                <div>
                  <h3>{step.title}</h3>
                  <p>{step.description}</p>
                </div>
              </li>
            ))}
          </ol>
          <aside className={styles.procedures} aria-labelledby="procedures-title">
            <div className={styles.proceduresHeading}>
              <h3 id="procedures-title">À chaque vente, ses règles.</h3>
              <p>Identifiez toujours le type de vente avant de vous lancer.</p>
            </div>
            <dl className={styles.procedureTypes}>
              <div>
                <dt>Au tribunal</dt>
                <dd>Un avocat du barreau compétent porte les enchères pour vous.</dd>
              </div>
              {notaryAndStatePilotsEnabled() ? (
                <>
                  <div>
                    <dt>Chez le notaire</dt>
                    <dd>
                      L’office notarial précise les garanties et les modalités de participation.
                    </dd>
                  </div>
                  <div>
                    <dt>Ventes domaniales</dt>
                    <dd>L’État fixe la procédure : enchères, appel d’offres ou vente amiable.</dd>
                  </div>
                </>
              ) : null}
            </dl>
          </aside>
          <div className={styles.methodActions}>
            <Link href="/ventes-immobilieres-judiciaires" className={styles.primaryLink}>
              Comprendre les enchères <ArrowRight aria-hidden="true" size={17} />
            </Link>
            <Link href="/sales" prefetch={false} className={styles.methodExplore}>
              Explorer les ventes <ArrowRight aria-hidden="true" size={17} />
            </Link>
          </div>
        </div>
      </section>

      <section className={styles.offers} aria-labelledby="offers-title">
        <div className={`${styles.container} ${styles.offersLayout}`}>
          <div className={styles.offersHeading}>
            <p className={styles.eyebrow}>Nos offres</p>
            <h2 id="offers-title">
              Explorez librement.
              <br />
              <em>Analysez en profondeur.</em>
            </h2>
          </div>
          <div className={styles.offersInner}>
            <div className={styles.plans}>
              <article className={styles.plan}>
                <h3>Découverte</h3>
                <p className={styles.planPrice}>
                  <PlanPrice label="0 €" />
                </p>
                <ul>
                  {discoveryFeatures.map((feature) => (
                    <li key={feature}>
                      <Check aria-hidden="true" size={14} />
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
              <article className={styles.plan}>
                <h3>Analyse</h3>
                <p className={styles.planPrice}>
                  <PlanPrice label={analysisPrice} />
                </p>
                <ul>
                  {analysisFeatures.map((feature) => (
                    <li key={feature}>
                      <Check aria-hidden="true" size={14} />
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
                    Essai de {ANALYSIS_TRIAL_DAYS} jours avec carte bancaire, puis abonnement
                    récurrent. Résiliable depuis votre compte.
                  </p>
                ) : checkoutOpen === false ? (
                  <p className={styles.planFinePrint}>
                    Tarif prévu : {analysisPrice}. Pas encore souscriptible.
                  </p>
                ) : null}
              </article>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
