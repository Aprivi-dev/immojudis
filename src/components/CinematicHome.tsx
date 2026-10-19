"use client";

import Image from "next/image";
import Form from "next/form";
import Link from "next/link";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import Search from "lucide-react/dist/esm/icons/search.js";
import { exampleHeadlineFigures } from "@/lib/example-sale";
import { formatNumber, formatPrice } from "@/lib/format";
import type { HomeCatalogueSummary } from "@/lib/home-catalogue-summary.server";
import { FREE_ACCESS_LINE } from "@/lib/sale-unlocks";
import { DOSSIER_APARTMENT_QUALITY, DOSSIER_APARTMENT_SIZES } from "./home-images";
import styles from "./CinematicHome.module.css";

// Same figures as /annonce-exemple: computed once from the example, not typed here.
const EXAMPLE_FIGURES = exampleHeadlineFigures();

const UPDATE_DATE_FORMAT = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "Europe/Paris",
});

/** « 1 753 ventes à venir · mises à jour le 15/10/2026 » ; la date seule peut manquer. */
export function catalogueSummaryLine({ count, updatedAt }: HomeCatalogueSummary): string {
  const sales = `${formatNumber(count)} vente${count > 1 ? "s" : ""} à venir`;
  const date = updatedAt ? new Date(updatedAt) : null;
  return date && Number.isFinite(date.getTime())
    ? `${sales} · mises à jour le ${UPDATE_DATE_FORMAT.format(date)}`
    : sales;
}

export function CinematicHero({ summary = null }: { summary?: HomeCatalogueSummary | null }) {
  return (
    <section className={styles.hero} aria-labelledby="home-title">
      <Image
        className={styles.poster}
        src="/media/landing/home-bordeaux-twilight.webp"
        alt=""
        fill
        preload
        quality={85}
        sizes="100vw"
      />
      <div className={styles.shade} />
      <div className={styles.content}>
        <div className={styles.introduction}>
          <p className={styles.eyebrow}>L’horizon immobilier</p>
          <h1 id="home-title">
            Les enchères
            <br />
            immobilières,
            <br />
            en toute <em>clarté.</em>
          </h1>
          <p className={styles.lead}>
            Les annonces, les documents et les chiffres pour préparer votre décision.
          </p>
          <Form action="/sales" className={styles.search} role="search">
            <Search size={23} aria-hidden="true" />
            <label className="sr-only" htmlFor="home-search">
              Ville, département ou code postal
            </label>
            <input
              id="home-search"
              name="q"
              type="search"
              placeholder="Ville, département ou code postal"
            />
            <button type="submit">
              Explorer les ventes <ArrowRight size={19} aria-hidden="true" />
            </button>
          </Form>
          <div className={styles.facts}>
            {summary ? (
              <p>
                <Link href="/sales" prefetch={false}>
                  {catalogueSummaryLine(summary)}
                </Link>
              </p>
            ) : null}
            <p>
              <Link href="/offres">{FREE_ACCESS_LINE}</Link>
            </p>
          </div>
          <Link className={styles.exampleLink} href="/annonce-exemple" prefetch={false}>
            Voir une analyse exemple <ArrowRight size={18} aria-hidden="true" />
          </Link>
          <p className={styles.caption}>
            Une autre façon
            <br />
            d’envisager l’immobilier.
          </p>
        </div>

        <article id="exemples" className={styles.dossier} aria-labelledby="home-dossier-title">
          <div className={styles.dossierPhoto}>
            <Image
              src="/media/landing/dossier-apartment.webp"
              alt="Appartement lumineux avec moulures et parquet, visuel d’illustration"
              fill
              loading="eager"
              fetchPriority="high"
              sizes={DOSSIER_APARTMENT_SIZES}
              quality={DOSSIER_APARTMENT_QUALITY}
            />
            <span className={styles.fictionBadge}>Exemple fictif</span>
          </div>
          <div className={styles.dossierBody}>
            <h2 id="home-dossier-title">
              Appartement · {EXAMPLE_FIGURES.city} · {EXAMPLE_FIGURES.surfaceM2} m²
            </h2>
            <dl className={styles.figures}>
              <div>
                <dt>Mise à prix</dt>
                <dd>{formatPrice(EXAMPLE_FIGURES.startingPrice)}</dd>
              </div>
              <div>
                <dt>Valeur estimée</dt>
                <dd>{formatPrice(EXAMPLE_FIGURES.marketValue)}</dd>
              </div>
              <div>
                <dt>Frais et travaux</dt>
                <dd>−{formatPrice(EXAMPLE_FIGURES.feesAndWorks)}</dd>
              </div>
              <div>
                <dt>Marge de sécurité</dt>
                <dd>−{formatPrice(EXAMPLE_FIGURES.safetyMargin)}</dd>
              </div>
            </dl>
            <div className={styles.ceiling}>
              <span>Enchère plafond (simulation)</span>
              <strong>{formatPrice(EXAMPLE_FIGURES.ceiling)}</strong>
            </div>
            <p className={styles.assumptions}>
              Simulation simplifiée, selon les hypothèses du scénario. Hors financement et
              fiscalité.
            </p>
          </div>
        </article>
      </div>
    </section>
  );
}
