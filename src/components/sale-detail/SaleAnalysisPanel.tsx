"use client";

import type { ReactNode } from "react";
import {
  CEILING_PROFILES,
  CEILING_PROJECTS,
  ceilingsByWorks,
  type CeilingHypotheses,
} from "@/lib/bid-ceiling-engine";
import { formatPrice } from "@/lib/format";
import type { PriceSummaryCeiling } from "./PriceSummaryCard";
import styles from "./SaleAnalysisPanel.module.css";

/** « Habiter · Équilibré · sans travaux » : les hypothèses du plafond en une ligne. */
export function hypothesesSummary(h: CeilingHypotheses): string {
  const project = CEILING_PROJECTS.find((item) => item.key === h.project)?.label ?? null;
  const profile =
    h.customMarginPct != null
      ? `marge personnalisée ${h.customMarginPct} %`
      : (CEILING_PROFILES.find((item) => item.key === h.profile)?.label ?? null);
  const works =
    h.works.key === "aucun" || h.works.amount <= 0
      ? "sans travaux"
      : h.works.key === "devis"
        ? `travaux ${formatPrice(h.works.amount)}`
        : (ceilingsByWorks(h)
            .find((row) => row.key === h.works.key)
            ?.label.toLowerCase() ?? `travaux ${formatPrice(h.works.amount)}`);
  return [project, profile, works].filter(Boolean).join(" · ");
}

/**
 * Tête du panneau « Votre analyse » (offre Analyse) : l'enchère plafond en grand, son écart avec la
 * mise à prix (pastille verte ou rouge, dite en toutes lettres, sans conseil), les deux autres
 * montants et le résumé des hypothèses, avec un lien pour les modifier.
 */
export function AnalysisLead({
  label,
  ceiling,
  startLabel,
  startingPrice,
  value,
  hypotheses,
  modifyHref,
}: {
  label: ReactNode;
  ceiling: PriceSummaryCeiling | null;
  /** « Mise à prix », « Première offre possible », « Prix publié ». */
  startLabel: string;
  startingPrice: number | null;
  value: number | null;
  /** Le résumé des hypothèses ; absent sans plafond chiffré. */
  hypotheses: string | null;
  modifyHref: string;
}) {
  const startTerm = startLabel.toLowerCase();
  const gap = ceiling?.kind === "amount" ? (ceiling.startGap ?? null) : null;
  return (
    <div className={styles.lead}>
      <p className={styles.eyebrow}>Votre analyse</p>
      <p className={styles.label}>{label}</p>
      {ceiling?.kind === "amount" ? (
        <p className={styles.ceiling}>{formatPrice(ceiling.amount)}</p>
      ) : ceiling?.kind === "note" ? (
        <p className={styles.ceilingNote}>{ceiling.note}</p>
      ) : ceiling?.kind === "locked" ? (
        <p className={styles.note}>{ceiling.action}</p>
      ) : (
        <p className={styles.ceilingNote}>Non disponible pour cette vente</p>
      )}
      {gap != null ? (
        <p className={`${styles.gap} ${gap >= 0 ? styles.gapUp : styles.gapDown}`}>
          {gap > 0
            ? `+${formatPrice(gap)} par rapport à la ${startTerm}`
            : gap === 0
              ? `Égale à la ${startTerm}`
              : `${formatPrice(-gap)} sous la ${startTerm}, à ces hypothèses`}
        </p>
      ) : null}
      <p className={styles.note}>
        {startLabel}{" "}
        <span className="tabular-nums">
          {startingPrice != null ? formatPrice(startingPrice) : "à confirmer"}
        </span>
        {value != null ? (
          <>
            {" · valeur estimée "}
            <span className="tabular-nums">{formatPrice(value)}</span>
          </>
        ) : null}
      </p>
      {hypotheses ? (
        <p className={styles.note}>
          {hypotheses} ·{" "}
          <a href={modifyHref} className={styles.link} aria-label="Modifier les hypothèses">
            Modifier
          </a>
        </p>
      ) : null}
    </div>
  );
}
