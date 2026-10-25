import Link from "next/link";
import type { CSSProperties } from "react";
import { exampleHeadlineFigures } from "@/lib/example-sale";
import { formatNumber, formatPrice } from "@/lib/format";
import type { HomeCatalogueSummary } from "@/lib/home-catalogue-summary.server";
import { notaryAndStatePilotsEnabled } from "@/lib/sale-types";
import { ArrowRight, Check, WarningCircle } from "./HomeIcons";
import { HomePrimaryAction } from "./HomePrimaryAction";
import styles from "./HomePage.module.css";

// Mêmes chiffres que /annonce-exemple : calculés une fois depuis l'exemple, jamais saisis ici.
const EXAMPLE = exampleHeadlineFigures();

const UPDATE_DATE_FORMAT = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "Europe/Paris",
});

function delay(ms: number): CSSProperties {
  return { "--delay": `${ms}ms` } as CSSProperties;
}

function verifiedDate(verifiedAt: string | null): string | null {
  const date = verifiedAt ? new Date(verifiedAt) : null;
  return date && Number.isFinite(date.getTime()) ? UPDATE_DATE_FORMAT.format(date) : null;
}

/**
 * « 1 753 ventes à venir · données vérifiées le 15/10/2026 » ; la date seule peut manquer. C'est la
 * date de la dernière collecte réussie, pas celle d'une modification d'annonce : la ligne ne dit pas
 * que les ventes ont « été mises à jour ».
 */
export function catalogueSummaryLine({ count, verifiedAt }: HomeCatalogueSummary): string {
  const sales = `${formatNumber(count)} vente${count > 1 ? "s" : ""} à venir`;
  const date = verifiedDate(verifiedAt);
  return date ? `${sales} · données vérifiées le ${date}` : sales;
}

/** Premier écran : la promesse, l'action principale, les chiffres réels et la fiche exemple. */
export function HomeHero({
  summary = null,
  departments = null,
}: {
  summary?: HomeCatalogueSummary | null;
  departments?: number | null;
}) {
  return (
    <section className={styles.hero} aria-labelledby="home-title">
      <div className={`${styles.container} ${styles.heroGrid}`}>
        <div className={styles.heroCopy}>
          <p className={`${styles.eyebrow} ${styles.heroAnim}`}>
            Pour acheter aux enchères en sachant jusqu’où monter
          </p>
          <h1 id="home-title" className={styles.heroAnim} style={delay(80)}>
            Les enchères <br />
            immobilières, <br />
            en toute <span className={styles.clarte}>clarté.</span>
          </h1>
          <p className={`${styles.lead} ${styles.heroAnim}`} style={delay(160)}>
            {notaryAndStatePilotsEnabled()
              ? "Les ventes des tribunaux, des notaires et de l’État réunies sur une carte."
              : "Les ventes des tribunaux réunies sur une carte."}{" "}
            Pour les ventes au tribunal, les pièces lues et l’enchère à ne pas dépasser.
          </p>
          <div className={styles.heroAnim} style={delay(240)}>
            <HomePrimaryAction />
          </div>
          {summary ? (
            <p className={`${styles.proof} ${styles.heroAnim}`} style={delay(320)}>
              <Link href="/sales" prefetch={false}>
                <span className={styles.proofDot} aria-hidden />
                <span className={styles.proofFigure}>
                  <b>{formatNumber(summary.count)}</b> vente{summary.count > 1 ? "s" : ""} à venir
                </span>
                {departments ? (
                  <>
                    {" "}
                    <span className={styles.proofSep} aria-hidden>
                      ·
                    </span>{" "}
                    <span>
                      <b>{formatNumber(departments)}</b> département{departments > 1 ? "s" : ""}
                    </span>
                  </>
                ) : null}
                {verifiedDate(summary.verifiedAt) ? (
                  <>
                    {" "}
                    <span className={styles.proofSep} aria-hidden>
                      ·
                    </span>{" "}
                    <span>données vérifiées le {verifiedDate(summary.verifiedAt)}</span>
                  </>
                ) : null}
              </Link>
            </p>
          ) : null}
        </div>
        <HomeExampleCard />
      </div>
    </section>
  );
}

/**
 * La fiche de l'annonce exemple de Bordeaux (fictive) : le calcul de l'enchère plafond, dessiné à
 * l'échelle de la valeur estimée. Mêmes chiffres que /annonce-exemple.
 */
function HomeExampleCard() {
  const share = (value: number) => `${((value / EXAMPLE.marketValue) * 100).toFixed(1)}%`;
  return (
    <figure
      className={`${styles.saleCard} ${styles.heroAnim}`}
      style={delay(200)}
      aria-label={`Exemple fictif : analyse d’un appartement de ${EXAMPLE.surfaceM2} m² à ${EXAMPLE.city}`}
    >
      <div className={styles.saleTop}>
        <div>
          <p className={styles.saleTitle}>
            Appartement T3 de {EXAMPLE.surfaceM2}&nbsp;m² à {EXAMPLE.city}
          </p>
          <p className={styles.saleMeta}>Tribunal judiciaire de {EXAMPLE.city} · avec balcon</p>
        </div>
        <span className={styles.tag}>Exemple fictif</span>
      </div>
      <ExamplePlan />
      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt>Mise à prix</dt>
          <dd>{formatPrice(EXAMPLE.startingPrice)}</dd>
        </div>
        <div className={styles.fact}>
          <dt>Valeur estimée</dt>
          <dd>{formatPrice(EXAMPLE.marketValue)}</dd>
        </div>
        <div className={styles.fact}>
          <dt>Surface Carrez</dt>
          <dd>{EXAMPLE.surfaceM2}&nbsp;m²</dd>
        </div>
      </dl>
      <div className={styles.ceiling}>
        <p className={styles.ceilingHead}>
          <span>Enchère plafond</span> <b>{formatPrice(EXAMPLE.ceiling)}</b>
        </p>
        <div className={`${styles.bar} ${styles.barGrow}`} aria-hidden>
          <i className={styles.barCeiling} style={{ width: share(EXAMPLE.ceiling) }} />
          <i className={styles.barCosts} style={{ width: share(EXAMPLE.feesAndWorks) }} />
          <i className={styles.barMargin} style={{ width: share(EXAMPLE.safetyMargin) }} />
        </div>
        <ul className={styles.legend}>
          <li>
            <span>
              <i className={styles.barCeiling} aria-hidden />
              Enchère plafond
            </span>{" "}
            <b>{formatPrice(EXAMPLE.ceiling)}</b>
          </li>
          <li>
            <span>
              <i className={styles.barCosts} aria-hidden />
              Frais et travaux de rafraîchissement
            </span>{" "}
            <b>{formatPrice(EXAMPLE.feesAndWorks)}</b>
          </li>
          <li>
            <span>
              <i className={styles.barMargin} aria-hidden />
              Marge de sécurité
            </span>{" "}
            <b>{formatPrice(EXAMPLE.safetyMargin)}</b>
          </li>
          <li className={styles.legendTotal}>
            <span>Valeur estimée du bien</span> <b>{formatPrice(EXAMPLE.marketValue)}</b>
          </li>
        </ul>
      </div>
      <ul className={styles.checks}>
        <li className={styles.tag}>
          <Check aria-hidden size={14} />
          Pièces lues
        </li>
        <li className={styles.tag}>
          <WarningCircle aria-hidden size={14} />
          Occupation à vérifier
        </li>
        <li className={styles.tag}>DPE&nbsp;D</li>
      </ul>
      <Link
        href="/annonce-exemple"
        prefetch={false}
        className={`${styles.textLink} ${styles.saleLink}`}
      >
        Voir l’analyse complète de l’exemple <ArrowRight aria-hidden size={16} />
      </Link>
    </figure>
  );
}

/** Plan schématique d'un trois pièces : illustration, sans cotes. */
function ExamplePlan() {
  return (
    <svg className={styles.floorPlan} viewBox="0 0 320 140" aria-hidden focusable="false">
      <rect className={styles.wall} x="12" y="12" width="296" height="116" rx="2" />
      <path
        className={styles.wall}
        d="M136 12V84M136 104V128M136 72H208M226 72H308M220 72V128M222 12V52"
      />
      <text x="24" y="32">
        Séjour
      </text>
      <text x="148" y="32">
        Chambre
      </text>
      <text x="234" y="32">
        Chambre
      </text>
      <text x="148" y="92">
        Cuisine
      </text>
      <text x="232" y="92">
        Bain
      </text>
    </svg>
  );
}
