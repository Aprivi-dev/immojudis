"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatPrice } from "@/lib/format";
import type { OverviewAction } from "./SaleListing";
import styles from "./SaleOverview.module.css";

/**
 * Sous 1024 px (téléphone et tablette), le plafond, le prix de départ et l'action principale restent
 * à portée, sur tous les onglets, une fois les boutons de la synthèse (`[data-hero-actions]`)
 * passés au-dessus de l'écran ; pas avant de les avoir atteints (repasse design n° 43). Au-delà, le panneau collant de droite garde les montants en vue. Sans action
 * (section du calcul), la barre garde les deux montants : on ajuste les hypothèses sans perdre le
 * plafond de vue.
 */
export function MobileActionBar({
  priceLabel,
  price,
  ceiling = null,
  action,
  dossier = null,
}: {
  priceLabel: string;
  price: number | null;
  /** Le plafond calculé ; absent s'il n'y en a pas (ou s'il est en cours de vérification). */
  ceiling?: number | null;
  action: OverviewAction | null;
  /**
   * Offre Analyse : « plafond · Mon dossier ». Le plafond en grand avec sa légende (« votre plafond ·
   * 27 nov. »), et le bouton qui ouvre le dossier de travail à la place de l'action principale.
   */
  dossier?: { caption: string; onOpen: () => void } | null;
}) {
  const [heroActionsPassed, setHeroActionsPassed] = useState(false);
  useEffect(() => {
    const target = document.querySelector("[data-hero-actions]");
    if (!target || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) =>
      setHeroActionsPassed(!entry.isIntersecting && entry.boundingClientRect.top < 0),
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  const visible = (Boolean(action) || ceiling != null || Boolean(dossier)) && heroActionsPassed;
  // Un élément pris au clavier en bas d'écran ne passe pas sous la barre (WCAG 2.4.11).
  useEffect(() => {
    if (!visible) return;
    const root = document.documentElement;
    const previous = root.style.scrollPaddingBottom;
    root.style.scrollPaddingBottom = "88px";
    return () => {
      root.style.scrollPaddingBottom = previous;
    };
  }, [visible]);

  if (!visible) return null;
  return (
    <>
      {/* Réserve la hauteur de la barre en bas de page : elle ne recouvre pas le pied de page. */}
      <div aria-hidden className="h-20 min-[1024px]:hidden" />
      <div className={styles.mobileBar} data-testid="mobile-action-bar">
        {dossier && ceiling != null ? (
          <>
            <p className={styles.mobileBarDossier}>
              <strong>{formatPrice(ceiling)}</strong>
              <span>{dossier.caption}</span>
            </p>
            <button type="button" className={styles.mobileBarAction} onClick={dossier.onOpen}>
              Mon dossier
            </button>
          </>
        ) : (
          <>
            <p className={styles.mobileBarPrices}>
              {ceiling != null ? (
                <span className={styles.mobileBarPrice}>
                  Plafond
                  <strong className={styles.mobileBarCeiling}>{formatPrice(ceiling)}</strong>
                </span>
              ) : null}
              <span className={styles.mobileBarPrice}>
                {priceLabel}
                <strong>{price != null ? formatPrice(price) : "À confirmer"}</strong>
              </span>
            </p>
            {action ? (
              action.href.startsWith("#") ? (
                <a href={action.href} className={styles.mobileBarAction}>
                  {action.label}
                </a>
              ) : (
                <Link href={action.href} className={styles.mobileBarAction}>
                  {action.label}
                </Link>
              )
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
