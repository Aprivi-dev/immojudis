"use client";

import Image from "next/image";
import Form from "next/form";
import Link from "next/link";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import Search from "lucide-react/dist/esm/icons/search.js";
import styles from "./CinematicHome.module.css";

export function CinematicHero() {
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
          <Link className={styles.exampleLink} href="/annonce-exemple">
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
              sizes="(max-width: 760px) calc(100vw - 48px), (max-width: 1100px) 38vw, 480px"
              quality={85}
            />
            <span className={styles.fictionBadge}>Exemple fictif</span>
          </div>
          <div className={styles.dossierBody}>
            <h2 id="home-dossier-title">Appartement · Bordeaux · 68 m²</h2>
            <dl className={styles.figures}>
              <div>
                <dt>Mise à prix</dt>
                <dd>95 000 €</dd>
              </div>
              <div>
                <dt>Valeur estimée</dt>
                <dd>230 000 €</dd>
              </div>
              <div>
                <dt>Frais et travaux</dt>
                <dd>−50 000 €</dd>
              </div>
              <div>
                <dt>Marge de sécurité</dt>
                <dd>−25 000 €</dd>
              </div>
            </dl>
            <div className={styles.ceiling}>
              <span>Plafond simulé</span>
              <strong>155 000 €</strong>
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
