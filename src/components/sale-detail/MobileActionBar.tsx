"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatPrice } from "@/lib/format";
import type { OverviewAction } from "./SaleListing";
import styles from "./SaleOverview.module.css";

/**
 * Sous 960 px (téléphone et tablette), le plafond, le prix de départ et l'action principale restent
 * à portée, sur tous les onglets, quand les boutons du haut de page (`[data-hero-actions]`) sont
 * hors de l'écran. Au-delà, rappel dans la barre d'onglets (`SaleDetailTabNav`). Sans action
 * (onglet du calcul), la barre garde les deux montants : on ajuste les hypothèses sans perdre le
 * plafond de vue.
 */
export function MobileActionBar({
  priceLabel,
  price,
  ceiling = null,
  action,
}: {
  priceLabel: string;
  price: number | null;
  /** Le plafond calculé ; absent s'il n'y en a pas (ou s'il est en cours de vérification). */
  ceiling?: number | null;
  action: OverviewAction | null;
}) {
  const [heroActionsVisible, setHeroActionsVisible] = useState(true);
  useEffect(() => {
    const target = document.querySelector("[data-hero-actions]");
    if (!target || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) =>
      setHeroActionsVisible(entry.isIntersecting),
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  const visible = (Boolean(action) || ceiling != null) && !heroActionsVisible;
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
      <div aria-hidden className="h-20 min-[960px]:hidden" />
      <div className={styles.mobileBar} data-testid="mobile-action-bar">
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
      </div>
    </>
  );
}
