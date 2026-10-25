import Link from "next/link";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import { formatNumber } from "@/lib/format";
import type { HomeCatalogueSummary } from "@/lib/home-catalogue-summary.server";
import { notaryAndStatePilotsEnabled } from "@/lib/sale-types";
import { HomeFranceMap } from "./HomeFranceMap";
import { HomeFreeAccessLine, HomeSignupButton } from "./HomeFreeAccessLine";
import { HomeSearch } from "./HomeSearch";
import styles from "./HomePage.module.css";

const UPDATE_DATE_FORMAT = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "Europe/Paris",
});

/**
 * « 1 753 ventes à venir · données vérifiées le 15/10/2026 » ; la date seule peut manquer. C'est la
 * date de la dernière collecte réussie, pas celle d'une modification d'annonce : la ligne ne dit pas
 * que les ventes ont « été mises à jour ».
 */
export function catalogueSummaryLine({ count, verifiedAt }: HomeCatalogueSummary): string {
  const sales = `${formatNumber(count)} vente${count > 1 ? "s" : ""} à venir`;
  const date = verifiedAt ? new Date(verifiedAt) : null;
  return date && Number.isFinite(date.getTime())
    ? `${sales} · données vérifiées le ${UPDATE_DATE_FORMAT.format(date)}`
    : sales;
}

/** Premier écran : la promesse, la recherche et les chiffres réels, à côté de la carte animée. */
export function HomeHero({ summary = null }: { summary?: HomeCatalogueSummary | null }) {
  return (
    <section className={styles.hero} aria-labelledby="home-title">
      <div className={`${styles.container} ${styles.heroGrid}`}>
        <div className={styles.heroCopy}>
          <h1 id="home-title">
            Les enchères immobilières, <br />
            en toute <em>clarté.</em>
          </h1>
          <p className={styles.lead}>
            {notaryAndStatePilotsEnabled()
              ? "Tribunaux, notaires et État : les annonces, les pièces et les chiffres pour décider."
              : "Les ventes des tribunaux : les annonces, les pièces et les chiffres pour décider."}
          </p>
          <HomeSearch id="home-search" />
          <div className={styles.facts}>
            {summary ? (
              <p>
                <Link href="/sales" prefetch={false}>
                  {catalogueSummaryLine(summary)}
                </Link>
              </p>
            ) : null}
            <HomeFreeAccessLine />
          </div>
          <div className={styles.heroActions}>
            <HomeSignupButton className={styles.primaryLink} />
            <Link className={styles.textLink} href="/annonce-exemple" prefetch={false}>
              Voir une analyse exemple <ArrowRight size={17} aria-hidden="true" />
            </Link>
          </div>
        </div>
        <HomeFranceMap />
      </div>
    </section>
  );
}
