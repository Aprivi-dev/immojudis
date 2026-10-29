"use client";

import { Terme } from "@/components/ceiling/Terme";
import { listingSaleStatus, saleTimeConflict } from "@/lib/listing-evidence";
import { formatPrice } from "@/lib/format";
import { getSaleProcedure, paymentDeadlineLabel, saleIsTribunalVenue } from "@/lib/sale-procedure";
import { saleKeyFacts } from "@/lib/sale-key-facts";
import type { AuctionSale } from "@/lib/types";
import { lowerFirst } from "./FirstAuctionGuide";
import styles from "./SaleOverview.module.css";

const SHORT_DATE = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "short",
  timeZone: "Europe/Paris",
});
const TIME = new Intl.DateTimeFormat("fr-FR", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Paris",
});

/** « 19 nov. », ou `null` pour une date illisible. */
function shortDate(value: string): { day: string; time: string } | null {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return { day: SHORT_DATE.format(date), time: TIME.format(date).replace(":", " h ") };
}

/**
 * « Le déroulé de la vente » (tribunal) : visite, avocat et garantie, audience, délai de surenchère
 * et paiement. Les délais viennent des règles de la procédure ; une étape dont le délai n'est pas
 * connu n'est pas écrite. Rien pour une vente passée, reportée ou annulée, ni sans date lisible.
 */
export function SaleTimeline({
  sale,
  dateBlocked = false,
  priceBlocked = false,
}: {
  sale: AuctionSale;
  /** La date est en cours de vérification (relecture IA) : pas de déroulé daté. */
  dateBlocked?: boolean;
  /** La mise à prix est en cours de vérification : la garantie, qui en dépend, n'est pas chiffrée. */
  priceBlocked?: boolean;
}) {
  if (!saleIsTribunalVenue(sale) || dateBlocked || listingSaleStatus(sale)) return null;
  if (!sale.sale_date || saleTimeConflict(sale)) return null;
  const hearing = shortDate(sale.sale_date);
  if (!hearing) return null;
  const procedure = getSaleProcedure(sale);
  const keyFacts = saleKeyFacts(sale);
  const guarantee = priceBlocked ? null : procedure.guaranteeAmountEur;
  const overbidDays = procedure.overbidAllowed === false ? null : procedure.overbidWindowDays;
  const paymentDays = procedure.paymentDeadlineDays;

  return (
    <section className={styles.card} aria-labelledby="sale-timeline-title">
      <div className={styles.cardHead}>
        <h2 id="sale-timeline-title">Le déroulé de la vente</h2>
        <a href="#rendez-vous" className={styles.cardLink}>
          Toutes les démarches
        </a>
      </div>
      <ol className={styles.timeline}>
        {keyFacts.nextVisit ? (
          <li>
            <span className={styles.when}>Visite</span>
            <span className={styles.rail} aria-hidden />
            <span className={styles.what}>
              <strong>Visiter le bien</strong>
              <span>{keyFacts.nextVisit}</span>
            </span>
          </li>
        ) : null}
        <li>
          <span className={styles.when}>Avant l’audience</span>
          <span className={styles.rail} aria-hidden />
          <span className={styles.what}>
            <strong>Mandater un avocat</strong>
            <span>
              {procedure.eligibleBar
                ? `Inscrit au ${lowerFirst(procedure.eligibleBar)}`
                : "Inscrit au barreau du tribunal"}
              {guarantee != null ? (
                <>
                  , avec la <Terme terme="garantie-encherir">garantie pour enchérir</Terme> de{" "}
                  {formatPrice(guarantee)}
                </>
              ) : null}
            </span>
          </span>
        </li>
        <li className={styles.keyStep}>
          <span className={styles.when}>{hearing.day}</span>
          <span className={styles.rail} aria-hidden />
          <span className={styles.what}>
            <strong>
              <Terme terme="adjudication">Audience d’adjudication</Terme>
            </strong>
            <span>
              à {hearing.time}
              {procedure.venueName ? `, ${procedure.venueName}` : ""}
            </span>
          </span>
        </li>
        {overbidDays != null ? (
          <li>
            <span className={styles.when}>+{overbidDays} jours</span>
            <span className={styles.rail} aria-hidden />
            <span className={styles.what}>
              <strong>
                <Terme terme="surenchere">Délai de surenchère</Terme>
              </strong>
              <span>la vente n’est définitive qu’après ce délai</span>
            </span>
          </li>
        ) : null}
        {paymentDays != null ? (
          <li>
            <span className={styles.when}>
              {paymentDays === 60 ? "+2 mois" : `+${paymentDays} jours`}
            </span>
            <span className={styles.rail} aria-hidden />
            <span className={styles.what}>
              <strong>Paiement du prix et des frais</strong>
              <span>{paymentDeadlineLabel(paymentDays)}</span>
            </span>
          </li>
        ) : null}
      </ol>
    </section>
  );
}
