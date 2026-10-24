import Link from "next/link";
import type { CSSProperties } from "react";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import { exampleHeadlineFigures } from "@/lib/example-sale";
import { formatNumber, formatPrice } from "@/lib/format";
import type { HomeCatalogueSummary } from "@/lib/home-catalogue-summary.server";
import { notaryAndStatePilotsEnabled } from "@/lib/sale-types";
import { HomeFreeAccessLine } from "./HomeFreeAccessLine";
import { HomeSearch } from "./HomeSearch";
import styles from "./HomePage.module.css";

// Mêmes chiffres que /annonce-exemple : calculés une fois depuis l'exemple, jamais saisis ici.
const EXAMPLE_FIGURES = exampleHeadlineFigures();

function delay(ms: number): CSSProperties {
  return { "--delay": `${ms}ms` } as CSSProperties;
}

type Stat = { value: string; label: string; countTo?: number };

/** Les chiffres réels du catalogue ; un chiffre inconnu n'est pas affiché (jamais de repli inventé). */
export function HomeStats({
  summary,
  departments,
}: {
  summary: HomeCatalogueSummary | null;
  departments: number | null;
}) {
  const stats: Stat[] = [];
  if (summary) {
    stats.push({
      value: formatNumber(summary.count),
      countTo: summary.count,
      label: summary.count > 1 ? "ventes à venir en France" : "vente à venir en France",
    });
  }
  if (departments) {
    stats.push({
      value: formatNumber(departments),
      countTo: departments,
      label:
        departments > 1
          ? "départements où une vente est annoncée"
          : "département où une vente est annoncée",
    });
  }
  if (notaryAndStatePilotsEnabled()) {
    stats.push({ value: "3", label: "lieux de vente réunis : tribunal, notaire, État" });
  }
  if (!summary && !departments) return null;
  return (
    <section className={styles.stats} aria-label="Le catalogue en chiffres">
      <dl className={styles.container} data-reveal="">
        {stats.map((stat) => (
          <div key={stat.label} className={styles.stat}>
            <dt>{stat.label}</dt>
            <dd data-count-to={stat.countTo} className={styles.statValue}>
              {stat.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** De l'annonce à l'enchère : trois écrans, chacun avec sa petite illustration animée. */
export function HomeJourney() {
  return (
    <section className={styles.journey} aria-labelledby="journey-title">
      <div className={styles.container}>
        <div className={styles.sectionHead} data-reveal="">
          <p className={styles.eyebrow}>Comment ça marche</p>
          <h2 id="journey-title">De l’annonce à l’enchère, en trois écrans.</h2>
        </div>
        <ol className={styles.steps}>
          <li className={styles.step} data-reveal="">
            <span className={styles.stepNumber}>01</span>
            <h3>Repérer</h3>
            <p>La carte et la liste des ventes, avec les points à vérifier de chaque annonce.</p>
            <div className={styles.mini} aria-hidden="true">
              {[62, 48, 70].map((width, index) => (
                <span key={width} className={styles.miniRow} style={delay(300 + index * 160)}>
                  <i className={styles.miniThumb} />
                  <span className={styles.miniLines}>
                    <i style={{ width: `${width}%` }} />
                    <i style={{ width: `${width - 22}%` }} />
                  </span>
                  {index === 1 ? <b className={styles.miniChip}>À vérifier</b> : null}
                </span>
              ))}
            </div>
          </li>
          <li className={styles.step} data-reveal="" style={delay(140)}>
            <span className={styles.stepNumber}>02</span>
            <h3>Calculer son plafond</h3>
            <p>Valeur du marché, frais, travaux et marge : l’enchère à ne pas dépasser.</p>
            <div className={styles.mini}>
              <span className={styles.miniLabel}>
                Exemple fictif · {EXAMPLE_FIGURES.city}, avec travaux de rafraîchissement
              </span>
              <span className={styles.miniLine}>
                <span>Valeur estimée</span>
                <b>{formatPrice(EXAMPLE_FIGURES.marketValue)}</b>
              </span>
              <span className={styles.miniBar} aria-hidden="true">
                <i
                  style={
                    {
                      "--w": `${Math.round((EXAMPLE_FIGURES.ceiling / EXAMPLE_FIGURES.marketValue) * 100)}%`,
                    } as CSSProperties
                  }
                />
              </span>
              <span className={styles.miniLine}>
                <span>Enchère plafond</span>
                <b className={styles.gold}>{formatPrice(EXAMPLE_FIGURES.ceiling)}</b>
              </span>
            </div>
          </li>
          <li className={styles.step} data-reveal="" style={delay(280)}>
            <span className={styles.stepNumber}>03</span>
            <h3>Être prévenu</h3>
            <p>Une alerte sur votre secteur : chaque nouvelle vente arrive par e-mail.</p>
            <div className={styles.mini} aria-hidden="true">
              <span className={styles.toast} style={delay(500)}>
                <i />
                Nouvelle vente dans votre secteur
              </span>
              <span className={styles.toast} style={delay(900)}>
                <i />
                Date d’audience confirmée
              </span>
            </div>
          </li>
        </ol>
        <div className={styles.actions}>
          <Link href="/sales" prefetch={false} className={styles.primaryLink}>
            Explorer les ventes <ArrowRight size={17} aria-hidden="true" />
          </Link>
          <Link href="/ventes-immobilieres-judiciaires" className={styles.textLink}>
            Comprendre les enchères <ArrowRight size={17} aria-hidden="true" />
          </Link>
        </div>
      </div>
    </section>
  );
}

/** Ce qu'Immojudis montre de plus qu'une annonce : quatre tuiles qui s'animent à leur arrivée. */
export function HomeFeatures() {
  return (
    <section className={styles.features} aria-labelledby="features-title">
      <div className={styles.container}>
        <div className={styles.sectionHead} data-reveal="">
          <p className={styles.eyebrow}>Plus qu’une annonce</p>
          <h2 id="features-title">Ce que vous savez avant l’audience.</h2>
        </div>
        <div className={styles.bento}>
          <article className={`${styles.tile} ${styles.tileWide}`} data-reveal="">
            <h3>Les pièces, lues pour vous</h3>
            <p>
              Cahier des conditions de vente, procès-verbal descriptif : les points clés relevés,
              pièce par pièce.
            </p>
            <span className={styles.docLines} aria-hidden="true">
              {[false, true, false, true, false].map((highlight, index) => (
                <i
                  key={index}
                  className={highlight ? styles.highlight : undefined}
                  style={delay(300 + index * 180)}
                />
              ))}
            </span>
            <Link href="/annonce-exemple" prefetch={false} className={styles.tileLink}>
              Voir l’annonce exemple <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </article>
          <article className={styles.tile} data-reveal="" style={delay(120)}>
            <h3>Le marché autour</h3>
            <p>La mise à prix face aux ventes voisines enregistrées (DVF).</p>
            <span className={styles.bars} aria-hidden="true">
              {[42, 64, 34, 82, 56].map((height, index) => (
                <i
                  key={index}
                  className={index === 2 ? styles.barMine : undefined}
                  style={{ "--h": `${height}%`, ...delay(300 + index * 90) } as CSSProperties}
                />
              ))}
            </span>
            <Link href="/methode-ecart-marche" className={styles.tileLink}>
              La méthode <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </article>
          <article className={styles.tile} data-reveal="" style={delay(200)}>
            <h3>Les audiences de la semaine</h3>
            <p>Les prochaines ventes, jour par jour et tribunal par tribunal.</p>
            <span className={styles.days} aria-hidden="true">
              {["L", "M", "M", "J", "V"].map((day, index) => (
                <i key={index} className={index === 1 || index === 3 ? styles.dayBusy : undefined}>
                  {day}
                </i>
              ))}
            </span>
            <Link href="/audiences-a-venir" className={styles.tileLink}>
              Les audiences <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </article>
          <article
            className={`${styles.tile} ${styles.tileWide}`}
            data-reveal=""
            style={delay(280)}
          >
            <h3>Les tribunaux en chiffres</h3>
            <p>Volumes, mises à prix médianes et prochaines audiences de chaque tribunal.</p>
            <span className={styles.spark} aria-hidden="true">
              <svg viewBox="0 0 200 40" preserveAspectRatio="none">
                <polyline points="0,32 25,26 50,29 75,18 100,22 125,12 150,16 175,8 200,11" />
              </svg>
            </span>
            <Link href="/tribunaux" className={styles.tileLink}>
              Les tribunaux <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </article>
        </div>
      </div>
    </section>
  );
}

/** Dernier écran : la recherche, à nouveau, sur fond marine. */
export function HomeClosing() {
  return (
    <section className={styles.closing} aria-labelledby="closing-title">
      <div className={`${styles.container} ${styles.closingInner}`} data-reveal="">
        <h2 id="closing-title">
          Commencez par <em>votre secteur.</em>
        </h2>
        <HomeSearch id="home-search-end" tone="dark" />
        <HomeFreeAccessLine className={styles.closingNote} />
      </div>
    </section>
  );
}
