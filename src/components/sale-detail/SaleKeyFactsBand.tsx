"use client";

import { useMemo } from "react";
import { Terme } from "@/components/ceiling/Terme";
import { AiReviewField } from "@/components/sale-detail/AiReviewField";
import {
  getAiReviewFieldResult,
  type AiReviewProjectionReadModel,
  type AiReviewRequestStatus,
} from "@/lib/ai-review-guard";
import { formatPrice } from "@/lib/format";
import { listingDate } from "@/lib/sale-listing";
import { saleKeyFacts } from "@/lib/sale-key-facts";
import type { AuctionSale } from "@/lib/types";
import styles from "./SaleKeyFactsBand.module.css";

/**
 * One band at the top of the sale page with what a reader looks for first: the starting price,
 * the date and time of the hearing, the court, and the next visit when one is known. The price and
 * the date go through the same review guard as the rest of the page; an unknown court or visit is
 * left out (the grouped « non communiquées » block of the dossier says what the file does not give).
 */
export function SaleKeyFactsBand({
  sale,
  aiReviewProjections = null,
  aiReviewStatus = "ready",
}: {
  sale: AuctionSale;
  aiReviewProjections?: readonly AiReviewProjectionReadModel[] | null;
  aiReviewStatus?: AiReviewRequestStatus;
}) {
  const facts = useMemo(() => saleKeyFacts(sale), [sale]);
  const dateBlocked = getAiReviewFieldResult(
    aiReviewProjections,
    "sale.sale_date",
    aiReviewStatus,
  ).blocked;
  const review = { projections: aiReviewProjections, reviewStatus: aiReviewStatus };
  const source = { sourceName: sale.source_name, sourceUrl: sale.source_url };

  return (
    <section className={styles.band} aria-label="Repères de la vente">
      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt>
            {facts.priceLabel === "Mise à prix" ? (
              <Terme terme="mise-a-prix">{facts.priceLabel}</Terme>
            ) : (
              facts.priceLabel
            )}
          </dt>
          <dd className={styles.price}>
            <AiReviewField fieldKey="sale.starting_price_eur" {...review} {...source}>
              {facts.price == null ? "À confirmer" : formatPrice(facts.price)}
            </AiReviewField>
          </dd>
        </div>
        <div className={styles.fact}>
          <dt>{facts.eventLabel}</dt>
          <dd>
            {facts.status && !dateBlocked ? (
              facts.status
            ) : (
              <AiReviewField
                fieldKey="sale.sale_date"
                fallback="Date à confirmer"
                {...review}
                {...source}
              >
                {facts.eventDate ? listingDate(facts.eventDate) : "Date à confirmer"}
              </AiReviewField>
            )}
            {facts.timeConflict && !facts.status && !dateBlocked ? (
              <span className={styles.note}>Horaire à faire confirmer</span>
            ) : null}
          </dd>
        </div>
        {facts.venueName ? (
          <div className={styles.fact}>
            <dt>{facts.venueLabel}</dt>
            <dd>{facts.venueName}</dd>
          </div>
        ) : null}
        {facts.nextVisit && !dateBlocked ? (
          <div className={styles.fact}>
            <dt>Prochaine visite</dt>
            <dd>{facts.nextVisit}</dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}
