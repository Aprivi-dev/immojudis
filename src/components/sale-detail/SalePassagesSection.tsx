"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { fetchSalePassages } from "@/lib/client-api";
import {
  describePreviousPassage,
  describeTimelineEvent,
  formatPassageDate,
  type SalePassagesResponse,
  type SalePassagesSummary,
} from "@/lib/sale-passages";
import styles from "./SalePassagesSection.module.css";

function summaryLine(summary: SalePassagesSummary): string | null {
  const parts = [
    summary.previousPassageCount > 0
      ? summary.previousPassageCount > 1
        ? `Ce bien est déjà passé ${summary.previousPassageCount} fois aux enchères.`
        : "Ce bien est déjà passé aux enchères."
      : null,
    summary.postponementCount > 0
      ? summary.postponementCount > 1
        ? `La vente a été reportée ${summary.postponementCount} fois.`
        : "La vente a déjà été reportée."
      : null,
    summary.priceChangePct != null && summary.priceChangePct !== 0
      ? summary.priceChangePct < 0
        ? `La mise à prix a baissé de ${-summary.priceChangePct} %.`
        : `La mise à prix a augmenté de ${summary.priceChangePct} %.`
      : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" ") : null;
}

/**
 * « Historique de la vente »: earlier passages of the property and what changed
 * on this listing. Analyse sees the details; a free account sees whether there
 * is a history at all, never the dates or prices.
 */
export function SalePassagesSection({
  saleId,
  startingPrice,
  enabled,
}: {
  saleId: string;
  startingPrice: number | null;
  enabled: boolean;
}) {
  const query = useQuery<SalePassagesResponse>({
    queryKey: ["sale-passages", saleId],
    queryFn: () => fetchSalePassages(saleId),
    enabled,
    staleTime: 10 * 60_000,
    retry: false,
  });
  if (!enabled || !query.data) return null;
  const data = query.data;
  const highlight = summaryLine(data.summary);

  if (data.access === "teaser") {
    if (!highlight) return null;
    return (
      <section id="historique" className={styles.card} aria-labelledby="sale-passages-title">
        <h2 id="sale-passages-title">Historique de la vente</h2>
        <p className={styles.highlight}>{highlight}</p>
        <p className={styles.lead}>
          Dates des audiences précédentes, mises à prix successives et reports : le détail est
          inclus dans l’offre Analyse.
        </p>
        <Link href="/offres" className={styles.cta}>
          Découvrir l’offre Analyse
        </Link>
      </section>
    );
  }

  const events = data.timeline.filter((event) => event.kind !== "first_seen");
  const firstSeen = data.timeline.find((event) => event.kind === "first_seen");
  return (
    <section id="historique" className={styles.card} aria-labelledby="sale-passages-title">
      <h2 id="sale-passages-title">Historique de la vente</h2>
      {highlight ? (
        <p className={styles.highlight}>{highlight}</p>
      ) : (
        <p className={styles.lead}>
          Aucun passage précédent ni changement repéré pour cette vente
          {firstSeen ? ` depuis le ${formatPassageDate(firstSeen.observedAt)}` : ""}.
        </p>
      )}
      {data.previousPassages.length || events.length ? (
        <ol className={styles.list}>
          {[...events].reverse().map((event, index) => {
            const text = describeTimelineEvent(event);
            return (
              <li key={`event-${index}`} className={styles.item}>
                <p className={styles.itemTitle}>{text.title}</p>
                {text.detail ? <p className={styles.itemDetail}>{text.detail}</p> : null}
                <p className={styles.itemDate}>
                  Constaté le {formatPassageDate(event.observedAt)}
                  {event.backfilled ? " · valeur précédente reconstituée" : ""}
                </p>
              </li>
            );
          })}
          {data.previousPassages.map((passage) => {
            const text = describePreviousPassage(passage, startingPrice);
            return (
              <li key={passage.saleDate} className={`${styles.item} ${styles.itemPassage}`}>
                <p className={styles.itemTitle}>{text.title}</p>
                {text.detail ? <p className={styles.itemDetail}>{text.detail}</p> : null}
                <p className={styles.itemDate}>Issue de cette audience non publiée</p>
              </li>
            );
          })}
        </ol>
      ) : null}
      <p className={styles.note}>
        Un passage précédent est retenu quand une annonce plus ancienne décrit le même bien : même
        numéro et même rue, même commune, même type et surface à 2 % près. Un bien remis en vente
        après une audience sans enchère, une surenchère ou une baisse de mise à prix apparaît ici.
      </p>
    </section>
  );
}
