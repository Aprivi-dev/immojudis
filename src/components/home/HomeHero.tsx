import Link from "next/link";
import { formatNumber, formatNumericDate } from "@/lib/format";
import type { HomeCatalogueSummary } from "@/lib/home-catalogue-summary.server";
import { isFeeRegimeOpen, type FeeRegimeKey } from "@/lib/fee-regime-open";
import { notaryAndStatePilotsEnabled } from "@/lib/sale-types";
import { HomePainting } from "./HomePainting";
import { HomeHeroActions } from "./HomePrimaryAction";
import styles from "./HomePage.module.css";
import scenes from "./HomeScenes.module.css";

/**
 * « 1 753 ventes à venir · données vérifiées le 15/10/2026 » ; la date seule peut manquer. C'est la
 * date de la dernière collecte réussie, pas celle d'une modification d'annonce : la ligne ne dit pas
 * que les ventes ont « été mises à jour ».
 */
export function catalogueSummaryLine({ count, verifiedAt }: HomeCatalogueSummary): string {
  const sales = `${formatNumber(count)} vente${count > 1 ? "s" : ""} à venir`;
  const date = formatNumericDate(verifiedAt, "");
  return date ? `${sales} · données vérifiées le ${date}` : sales;
}

/**
 * Premier écran (refonte du 24/11/2026) : la promesse, ce que la fiche réunit, le catalogue en
 * action principale, les chiffres réels, et la peinture de la Justice au travail.
 */
export function HomeHero({
  summary = null,
  departments = null,
  openFeeRegimes,
}: {
  summary?: HomeCatalogueSummary | null;
  departments?: number | null;
  /** Régimes dont le plafond est ouvert (`CEILING_FEE_REGIMES_OPEN`) ; absent : ceux par défaut. */
  openFeeRegimes?: readonly FeeRegimeKey[];
}) {
  // Le plafond existe pour le tribunal et, quand son régime est ouvert, pour la vente notariale ;
  // jamais pour les ventes de l'État.
  const notaryCeiling =
    isFeeRegimeOpen("notary_auction", openFeeRegimes) ||
    isFeeRegimeOpen("notary_online", openFeeRegimes);
  return (
    <section className={scenes.hero} aria-labelledby="home-title">
      <HomePainting
        name="01-hero"
        alt="Peinture : la Justice, assise de profil, travaille sur un ordinateur portable ; une balance est posée près d’elle."
        sizes="(max-width: 960px) 200vw, 112vw"
        eager
        className={scenes.heroPainting}
      />
      <div className={`${styles.container} ${scenes.heroCopy}`} data-home-scene="hero-copy">
        <h1 id="home-title" className={scenes.rise}>
          Le prix se décide <br />
          avant l’audience.
        </h1>
        <p className={`${styles.lead} ${scenes.rise}`}>
          Pour chaque vente au tribunal{notaryCeiling ? " et chez le notaire" : ""} : ce que disent
          les pièces quand elles sont publiées, la valeur du quartier et l’enchère à ne pas dépasser
          selon votre projet.{" "}
          {notaryAndStatePilotsEnabled()
            ? "Les ventes des tribunaux, des notaires et de l’État sur une carte."
            : "Les ventes des tribunaux sur une carte."}
        </p>
        <div className={scenes.rise}>
          <HomeHeroActions />
        </div>
        {summary ? (
          <p className={`${styles.proof} ${scenes.rise}`}>
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
              {formatNumericDate(summary.verifiedAt, "") ? (
                <>
                  {" "}
                  <span className={styles.proofSep} aria-hidden>
                    ·
                  </span>{" "}
                  <span>données vérifiées le {formatNumericDate(summary.verifiedAt, "")}</span>
                </>
              ) : null}
            </Link>
          </p>
        ) : null}
      </div>
    </section>
  );
}
