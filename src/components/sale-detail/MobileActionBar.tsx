"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatPrice } from "@/lib/format";
import type { OverviewAction } from "./SaleListing";
import styles from "./SaleOverview.module.css";

/**
 * Sur téléphone, le prix et l'action principale restent à portée quand les boutons du haut de page
 * (`[data-hero-actions]`) sont hors de l'écran. Masquée sur grand écran (CSS) et tant que ces
 * boutons sont visibles.
 */
export function MobileActionBar({
  priceLabel,
  price,
  action,
}: {
  priceLabel: string;
  price: number | null;
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

  if (!action || heroActionsVisible) return null;
  return (
    <>
      {/* Réserve la hauteur de la barre en bas de page : elle ne recouvre pas le pied de page. */}
      <div aria-hidden className="h-20 md:hidden" />
      <div className={styles.mobileBar} data-testid="mobile-action-bar">
        <span className={styles.mobileBarPrice}>
          {priceLabel}
          <strong>{price != null ? formatPrice(price) : "À confirmer"}</strong>
        </span>
        {action.href.startsWith("#") ? (
          <a href={action.href} className={styles.mobileBarAction}>
            {action.label}
          </a>
        ) : (
          <Link href={action.href} className={styles.mobileBarAction}>
            {action.label}
          </Link>
        )}
      </div>
    </>
  );
}
