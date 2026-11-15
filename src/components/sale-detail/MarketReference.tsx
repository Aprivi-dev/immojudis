"use client";

import Link from "next/link";
import { formatPrice } from "@/lib/format";
import { describeMarketGap } from "@/lib/market-gap";
import {
  MARKET_GAP_BAND_LABELS,
  MARKET_GAP_BAND_METHOD_LABEL,
  MARKET_GAP_BAND_METHOD_PATH,
  MARKET_GAP_BAND_STARTING_PRICE_NOTE,
  type MarketGapBand,
  type PublicMarketGapBand,
} from "@/lib/market-gap-band";
import type { ValuePreview } from "@/lib/value-preview";
import styles from "./SaleOverview.module.css";

/**
 * Où la mise à prix se place par rapport à la fourchette de valeur : 0 à 100 sur une échelle qui part
 * de zéro (une échelle tronquée grossirait l'écart). `null` sans écart montrable.
 */
export function marketReferenceScale(startingPrice: number, low: number, high: number) {
  const max = Math.max(high, startingPrice) * 1.08;
  const at = (value: number) => Math.round((value / max) * 1000) / 10;
  return { start: at(startingPrice), low: at(low), high: at(high) };
}

/** Le niveau situe la mise à prix (sous, dans, au-dessus de la fourchette), au lieu d'en dire la raison. */
export function isMarketGapPosition(band: PublicMarketGapBand): band is MarketGapBand {
  return band === "under" || band === "near" || band === "above";
}

/**
 * « Repère marché » du haut de la fiche : la fourchette de valeur estimée du bien (ventes
 * comparables DVF), lue sur le même aperçu de valeur que le panneau de prix (`/api/value-preview`). La barre qui place la
 * mise à prix n'apparaît que quand l'écart est montrable : jamais pour un bien occupé ou
 * d'occupation inconnue (la valeur s'appuie sur des ventes de biens libres), ni pour un écart
 * aberrant. Ces cas gardent la phrase de `describeMarketGap`. Un compte gratuit, sur une vente qu'il
 * n'a pas débloquée, ne lit que le niveau d'écart (`band`), sans montant. Un visiteur voit
 * l'invitation à créer un compte, comme dans le panneau de prix.
 */
export function MarketReference({
  startingPrice,
  preview,
  band = null,
  loading = false,
  signupHref = null,
  startLabel = "La mise à prix",
}: {
  startingPrice: number | null;
  /** Le nom du prix de départ en début de phrase (« La première offre possible »…). */
  startLabel?: string;
  preview: ValuePreview | null;
  /** Compte gratuit, vente non débloquée : le niveau d'écart seul, à la place de la fourchette. */
  band?: PublicMarketGapBand | null;
  loading?: boolean;
  /** Visiteur : lien d'inscription à la place de la fourchette. */
  signupHref?: string | null;
}) {
  if (signupHref) {
    return (
      <div className={styles.marketReference}>
        <p className={styles.eyebrow}>Repère marché</p>
        <p className={styles.lockNote}>
          La fourchette de valeur estimée du bien est réservée à l’offre Analyse et aux ventes
          débloquées. <Link href={signupHref}>Créez un compte gratuit</Link>, puis débloquez la
          vente.
        </p>
      </div>
    );
  }
  if (loading) {
    return (
      <div className={styles.marketReference}>
        <p className={styles.eyebrow}>Repère marché</p>
        <p className={styles.muted}>Calcul de la fourchette de valeur…</p>
      </div>
    );
  }
  if (!preview?.available || preview.lowEur == null || preview.highEur == null) {
    if (!band) return null;
    return (
      <div className={styles.marketReference} data-testid="market-reference" data-band={band}>
        <p className={styles.eyebrow}>Repère marché</p>
        <p className={styles.marketRange}>{MARKET_GAP_BAND_LABELS[band]}</p>
        <p className={styles.muted}>
          {isMarketGapPosition(band) ? `${MARKET_GAP_BAND_STARTING_PRICE_NOTE} ` : null}
          <Link
            href={MARKET_GAP_BAND_METHOD_PATH}
            className="font-semibold text-gold-text underline underline-offset-4"
          >
            {MARKET_GAP_BAND_METHOD_LABEL}
          </Link>
        </p>
      </div>
    );
  }

  const low = preview.lowEur;
  const high = preview.highEur;
  const gapSentence = describeMarketGap(preview);
  const showScale =
    startingPrice != null &&
    startingPrice > 0 &&
    preview.gapWithheld == null &&
    !preview.discountNotSignificant &&
    preview.discountPct != null;
  const scale = showScale ? marketReferenceScale(startingPrice, low, high) : null;
  const range = `${formatPrice(low)} – ${formatPrice(high)}`;

  return (
    <div className={styles.marketReference} data-testid="market-reference">
      <p className={styles.eyebrow}>Repère marché</p>
      {scale ? (
        <div
          className={styles.scale}
          role="img"
          aria-label={`Mise à prix de ${formatPrice(startingPrice!)} ; valeur estimée du bien entre ${formatPrice(low)} et ${formatPrice(high)}.`}
        >
          <span className={styles.scaleLine} aria-hidden />
          <span
            className={styles.scaleRange}
            style={{ left: `${scale.low}%`, width: `${Math.max(1, scale.high - scale.low)}%` }}
            aria-hidden
          />
          <span className={styles.scaleDot} style={{ left: `${scale.start}%` }} aria-hidden />
        </div>
      ) : null}
      <p className={styles.marketRange}>
        Fourchette indicative de la valeur du bien : <strong>{range}</strong>
      </p>
      <p className={styles.muted}>
        {showScale
          ? `${startLabel} n’est pas le prix d’achat probable : c’est un point de départ.`
          : gapSentence}
      </p>
    </div>
  );
}
