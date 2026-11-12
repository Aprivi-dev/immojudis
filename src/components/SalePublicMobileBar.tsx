"use client";

import { useEffect, useState, type ReactNode } from "react";

/** Repère de la synthèse de la fiche visiteur (prix et inscription), observé par la barre du bas. */
const SALE_PUBLIC_SYNTHESIS_ATTRIBUTE = "data-sale-synthesis";

/**
 * Barre du bas de la fiche visiteur (mobile et tablette ; la feuille de style la masque sur
 * ordinateur). Elle n'apparaît qu'une fois la synthèse (`[data-sale-synthesis]`) passée au-dessus de
 * l'écran : tant que le prix et l'inscription sont visibles ou à venir, elle ne les répète pas
 * (repasse design n° 43).
 * Visible, elle réserve sa hauteur au défilement (`scroll-padding-bottom`, comme `MobileActionBar`) :
 * un élément pris au clavier ne passe pas dessous (WCAG 2.4.11, repasse n° 8).
 */
export function SalePublicMobileBar({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}) {
  // Au premier rendu (serveur compris), la synthèse, sous le titre, n'est pas encore passée.
  const [synthesisPassed, setSynthesisPassed] = useState(false);
  useEffect(() => {
    const target = document.querySelector(`[${SALE_PUBLIC_SYNTHESIS_ATTRIBUTE}]`);
    if (!target || typeof IntersectionObserver === "undefined") {
      setSynthesisPassed(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) =>
      setSynthesisPassed(!entry.isIntersecting && entry.boundingClientRect.top < 0),
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  const visible = synthesisPassed;
  useEffect(() => {
    if (!visible) return;
    const root = document.documentElement;
    const previous = root.style.scrollPaddingBottom;
    // La barre est posée sur le bandeau des cookies tant qu'il est là : sa hauteur s'ajoute.
    root.style.scrollPaddingBottom = "calc(88px + var(--cookie-banner-height, 0px))";
    return () => {
      root.style.scrollPaddingBottom = previous;
    };
  }, [visible]);

  if (!visible) return null;
  return (
    <div className={className} data-testid="public-mobile-bar">
      {children}
    </div>
  );
}
