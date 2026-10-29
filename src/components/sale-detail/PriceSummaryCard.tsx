"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { formatPrice } from "@/lib/format";
import styles from "./SaleOverview.module.css";

export type PriceSummaryValue =
  | { kind: "amount"; amount: number; note: string }
  | { kind: "range"; low: number; high: number }
  | { kind: "signup"; href: string }
  | { kind: "pending" };

export type PriceSummaryCeiling =
  | { kind: "amount"; amount: number; note: string; reliability: string | null }
  | { kind: "note"; note: string }
  | { kind: "locked"; action: ReactNode };

/**
 * « Le prix » dans l'Aperçu : le prix de départ, la valeur estimée et le plafond, sans le calcul.
 * Chaque tuile dit ce que le compte peut lire ; le calcul complet est dans l'onglet Prix.
 */
export function PriceSummaryCard({
  startLabel,
  startingPrice,
  value,
  ceilingLabel,
  ceiling,
  detailHref,
}: {
  startLabel: ReactNode;
  /** `null` : non publié, ou en cours de vérification. */
  startingPrice: number | null;
  value: PriceSummaryValue | null;
  ceilingLabel: ReactNode;
  ceiling: PriceSummaryCeiling | null;
  /** Lien vers le calcul ou le panneau de prix. */
  detailHref: string;
}) {
  return (
    <section className={styles.card} aria-labelledby="price-summary-title">
      <div className={styles.cardHead}>
        <h2 id="price-summary-title">Le prix</h2>
        <a href={detailHref} className={styles.cardLink}>
          {ceiling?.kind === "amount" ? "Voir le calcul" : "Voir le détail"}
        </a>
      </div>
      <dl className={styles.tiles}>
        <div className={styles.tile}>
          <dt>{startLabel}</dt>
          <dd>
            <span className={styles.tileValue}>
              {startingPrice != null ? formatPrice(startingPrice) : "À confirmer"}
            </span>
            <span className={styles.tileNote}>prix de départ, hors frais</span>
          </dd>
        </div>
        {value ? (
          <div className={styles.tile}>
            <dt>Valeur estimée</dt>
            <dd>
              {value.kind === "amount" ? (
                <>
                  <span className={styles.tileValue}>{formatPrice(value.amount)}</span>
                  <span className={styles.tileNote}>{value.note}</span>
                </>
              ) : value.kind === "range" ? (
                <>
                  <span className={styles.tileValue}>
                    {formatPrice(value.low)} – {formatPrice(value.high)}
                  </span>
                  <span className={styles.tileNote}>fourchette, ventes comparables</span>
                </>
              ) : value.kind === "signup" ? (
                <span className={styles.tileNote}>
                  <Link href={value.href}>Créez un compte gratuit</Link> pour la voir
                </span>
              ) : (
                <span className={styles.tileNote}>Calcul…</span>
              )}
            </dd>
          </div>
        ) : null}
        {ceiling ? (
          <div className={`${styles.tile} ${styles.tileCeiling}`}>
            <dt>{ceilingLabel}</dt>
            <dd>
              {ceiling.kind === "amount" ? (
                <>
                  <span className={styles.tileValue}>{formatPrice(ceiling.amount)}</span>
                  <span className={styles.tileNote}>
                    {ceiling.note}
                    {ceiling.reliability ? ` · fiabilité : ${ceiling.reliability}` : ""}
                  </span>
                </>
              ) : ceiling.kind === "note" ? (
                <span className={styles.tileNote}>{ceiling.note}</span>
              ) : (
                <span className={styles.tileNote}>{ceiling.action}</span>
              )}
            </dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}
