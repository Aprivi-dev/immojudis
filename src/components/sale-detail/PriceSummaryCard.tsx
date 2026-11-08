"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { formatPrice } from "@/lib/format";
import styles from "./PriceTrio.module.css";

export type PriceSummaryValue =
  | {
      kind: "amount";
      amount: number;
      note: string;
      /** Fourchette de l'estimation (offre Analyse), quand elle existe. */
      range?: { low: number; high: number } | null;
    }
  | { kind: "range"; low: number; high: number }
  | { kind: "signup"; href: string }
  | { kind: "pending" };

export type PriceSummaryCeiling =
  | {
      kind: "amount";
      amount: number;
      note: string;
      reliability: string | null;
      /** Plafond moins prix de départ (`startingPriceGap` du moteur), quand les deux existent. */
      startGap?: number | null;
      /** Le prix de départ, sans article (« mise à prix », « première offre possible »). */
      startTerm?: string;
    }
  | { kind: "note"; note: string }
  | { kind: "locked"; action: ReactNode };

/**
 * Pourquoi la valeur n'est pas « estimée » pour ce bien mais celle d'un bien libre comparable : elle
 * s'appuie sur des ventes de biens libres (règle de `market-gap.ts`).
 */
export const FREE_VALUE_LABEL = "Valeur d’un bien libre comparable";
export const FREE_VALUE_REASON: Record<"occupied" | "occupancy_unknown", string> = {
  occupied: "Bien occupé : cette valeur s’appuie sur des ventes de biens libres.",
  occupancy_unknown:
    "Occupation non précisée : cette valeur s’appuie sur des ventes de biens libres.",
};

/**
 * L'écart du plafond au prix de départ, dit en toutes lettres et sans conseil : « 12 500 € au-dessus
 * de la mise à prix », « 8 000 € sous la mise à prix, à ces hypothèses ».
 */
export function ceilingStartGapLabel(gap: number, startTerm = "mise à prix"): string {
  if (gap === 0) return `Égale à la ${startTerm}`;
  return gap > 0
    ? `${formatPrice(gap)} au-dessus de la ${startTerm}`
    : `${formatPrice(-gap)} sous la ${startTerm}, à ces hypothèses`;
}

/**
 * « Le prix », en tête de la section Prix et plafond : trois montants côte à côte, le prix de départ,
 * le plafond (encadré d'or) et la valeur estimée. Chaque case dit ce que le compte peut lire.
 */
export function PriceSummaryCard({
  startLabel,
  startingPrice,
  value,
  valueWithheld = null,
  ceilingLabel,
  ceiling,
  detailHref,
}: {
  startLabel: ReactNode;
  /** `null` : non publié, ou en cours de vérification. */
  startingPrice: number | null;
  value: PriceSummaryValue | null;
  /** Bien occupé ou d'occupation inconnue : la valeur est dite celle d'un bien libre, avec le motif. */
  valueWithheld?: "occupied" | "occupancy_unknown" | null;
  ceilingLabel: ReactNode;
  ceiling: PriceSummaryCeiling | null;
  /** Lien vers le calcul ou le panneau de prix ; absent quand le calcul suit juste en dessous. */
  detailHref?: string | null;
}) {
  return (
    <section className={styles.card} aria-labelledby="price-summary-title">
      <div className={styles.head}>
        <h3 id="price-summary-title" className={styles.title}>
          Le prix
        </h3>
        {detailHref ? (
          <a href={detailHref} className={styles.link}>
            {ceiling?.kind === "amount" ? "Voir le calcul" : "Voir le détail"}
          </a>
        ) : null}
      </div>
      <dl className={styles.trio}>
        <div className={styles.tile}>
          <dt>{startLabel}</dt>
          <dd>
            <span className={styles.value}>
              {startingPrice != null ? formatPrice(startingPrice) : "À confirmer"}
            </span>
            <span className={styles.note}>Prix de départ, hors frais</span>
          </dd>
        </div>
        {ceiling ? (
          <div className={`${styles.tile} ${styles.ceiling}`}>
            <dt>{ceilingLabel}</dt>
            <dd>
              {ceiling.kind === "amount" ? (
                <>
                  <span className={styles.value}>{formatPrice(ceiling.amount)}</span>
                  {ceiling.startGap != null ? (
                    <span className={styles.note}>
                      {ceilingStartGapLabel(ceiling.startGap, ceiling.startTerm)}
                    </span>
                  ) : null}
                  <span className={styles.note}>
                    {ceiling.note}
                    {ceiling.reliability ? ` · fiabilité : ${ceiling.reliability}` : ""}
                  </span>
                </>
              ) : ceiling.kind === "note" ? (
                <span className={styles.note}>{ceiling.note}</span>
              ) : (
                <span className={styles.note}>{ceiling.action}</span>
              )}
            </dd>
          </div>
        ) : null}
        {value ? (
          <div className={styles.tile}>
            <dt>{valueWithheld ? FREE_VALUE_LABEL : "Valeur estimée"}</dt>
            <dd>
              {value.kind === "amount" ? (
                <>
                  <span className={styles.value}>{formatPrice(value.amount)}</span>
                  {value.range ? (
                    <span className={styles.note}>
                      Fourchette {formatPrice(value.range.low)} – {formatPrice(value.range.high)}
                    </span>
                  ) : null}
                  <span className={styles.note}>{value.note}</span>
                </>
              ) : value.kind === "range" ? (
                <>
                  <span className={styles.value}>
                    {formatPrice(value.low)} – {formatPrice(value.high)}
                  </span>
                  <span className={styles.note}>fourchette indicative, ventes comparables</span>
                </>
              ) : value.kind === "signup" ? (
                <span className={styles.note}>
                  <Link href={value.href}>Créez un compte gratuit</Link> pour la voir
                </span>
              ) : (
                <span className={styles.note}>Calcul…</span>
              )}
              {valueWithheld ? (
                <span className={styles.note}>{FREE_VALUE_REASON[valueWithheld]}</span>
              ) : null}
            </dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}
