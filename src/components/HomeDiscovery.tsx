"use client";

import Image from "next/image";
import Link from "next/link";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import Check from "lucide-react/dist/esm/icons/check.js";
import { BrandMark } from "@/components/BrandLogo";
import { resolveAnalysisOfferLabel } from "@/lib/analysis-offer";
import styles from "./HomeDiscovery.module.css";

const methodSteps = [
  {
    number: "01",
    title: "Repérez",
    description: "Accédez aux ventes et identifiez les biens qui vous intéressent.",
  },
  {
    number: "02",
    title: "Analysez",
    description: "Consultez les informations disponibles et évaluez les hypothèses du bien.",
  },
  {
    number: "03",
    title: "Préparez",
    description: "Définissez votre stratégie et préparez votre enchère avec une limite explicite.",
  },
] as const;

const discoveryFeatures = [
  "Accès aux annonces",
  "Informations essentielles",
  "Jusqu’à trois favoris",
] as const;

const analysisFeatures = [
  "Mise plafond et travaux",
  "Estimation et comparables",
  "Pièces et risques, selon la vente",
  "Simulation ajustable",
] as const;

export function HomeDiscovery() {
  const analysisPrice = resolveAnalysisOfferLabel();

  return (
    <div className={styles.root}>
      <section className={styles.method} aria-labelledby="method-title">
        <div className={styles.container}>
          <p className={styles.eyebrow}>Notre approche</p>
          <h2 id="method-title">Un dossier clair. Une décision préparée.</h2>
          <ol className={styles.steps}>
            {methodSteps.map((step) => (
              <li className={styles.step} key={step.number}>
                <span className={styles.stepNumber} aria-hidden="true">
                  {step.number}
                </span>
                <div>
                  <h3>{step.title}</h3>
                  <p>{step.description}</p>
                </div>
              </li>
            ))}
          </ol>
          <p className={styles.methodNote}>
            <span>Documents disponibles</span>
            <span>Comparables</span>
            <span>Simulation ajustable</span>
          </p>
        </div>
      </section>

      <section className={styles.offers} aria-labelledby="offers-title">
        <div className={styles.offersImage}>
          <Image
            src="/media/landing/dossier-apartment.webp"
            alt="Intérieur lumineux d’un appartement de caractère, visuel d’illustration"
            fill
            sizes="(max-width: 760px) 100vw, 50vw"
          />
          <p className={styles.imageCaption}>
            <strong>Visuel d’illustration</strong>
            <span>Les informations varient selon chaque vente.</span>
          </p>
        </div>
        <div className={styles.offersCopy}>
          <div className={styles.offersInner}>
            <p className={styles.eyebrow}>Nos offres</p>
            <h2 id="offers-title">
              Explorez librement.
              <br />
              Analysez en profondeur.
            </h2>
            <div className={styles.plans}>
              <article className={styles.plan}>
                <h3>Découverte</h3>
                <p className={styles.planPrice}>0 €</p>
                <ul>
                  {discoveryFeatures.map((feature) => (
                    <li key={feature}>
                      <Check aria-hidden="true" size={14} />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>
                <Link href="/sales" className={styles.secondaryLink}>
                  Explorer les ventes <ArrowRight aria-hidden="true" size={17} />
                </Link>
              </article>
              <article className={styles.plan}>
                <h3>Analyse</h3>
                <p className={styles.planPrice}>{analysisPrice}</p>
                <ul>
                  {analysisFeatures.map((feature) => (
                    <li key={feature}>
                      <Check aria-hidden="true" size={14} />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>
                <Link href="/accompagnement" className={styles.primaryLink}>
                  Découvrir Analyse <ArrowRight aria-hidden="true" size={17} />
                </Link>
                <p className={styles.planFinePrint}>
                  Essai de 7 jours avec carte bancaire, puis abonnement récurrent. Résiliable depuis
                  votre espace.
                </p>
              </article>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.banner} aria-labelledby="banner-title">
        <Image
          className={styles.bannerImage}
          src="/media/landing/gallery-townhouse.webp"
          alt=""
          fill
          sizes="100vw"
        />
        <div className={styles.bannerShade} aria-hidden="true" />
        <div className={`${styles.container} ${styles.bannerContent}`}>
          <p className={styles.eyebrow}>Plus qu’une annonce</p>
          <h2 id="banner-title">L’analyse fait la différence.</h2>
          <p>Prenez de meilleures décisions sur les ventes immobilières.</p>
        </div>
      </section>

      <footer className={styles.footer}>
        <div className={styles.footerTop}>
          <Link href="/" className={styles.brand} aria-label="ImmoJudis — accueil">
            <BrandMark variant="transparent" className={styles.brandMark} />
            <span>
              Immo<span>Judis</span>
              <small>Les ventes immobilières en toute clarté.</small>
            </span>
          </Link>
          <nav aria-label="Navigation pied de page">
            <Link href="/comment-ca-marche">Comment ça marche</Link>
            <Link href="/sales">Les ventes</Link>
            <Link href="/ressources">Ressources</Link>
            <Link href="/accompagnement">Offres</Link>
            <Link href="/contact">Contact</Link>
          </nav>
        </div>
        <div className={styles.footerBottom}>
          <span>© 2026 ImmoJudis</span>
          <nav aria-label="Informations légales">
            <Link href="/legal">Mentions légales</Link>
            <Link href="/conditions-generales">Conditions générales</Link>
            <Link href="/privacy">Confidentialité</Link>
            <Link href="/mes-droits">Mes droits</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
