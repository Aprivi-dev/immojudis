"use client";

import { useEffect, useRef, useState, type ComponentProps } from "react";
import { PriceScale } from "@/components/sale-detail/PriceScale";
import { useUsualAuctionRange } from "@/components/sale-detail/use-usual-auction-range";

/**
 * La réglette de prix avec, quand le compte y a droit, les prix habituellement atteints par les
 * ventes comparables (`useUsualAuctionRange` : même lecture que « Scénarios d'enchères »).
 *
 * La lecture ne part qu'à l'approche de l'écran (800 px, comme `WhenNear`) : ouvrir une fiche sans
 * descendre jusqu'au prix ne consomme ni le quota de calcul ni un événement « statistiques vues ».
 * Sans `IntersectionObserver` (vieux navigateur, rendu de test), elle part tout de suite.
 */
export function CourtPriceScale({
  saleId,
  access,
  userKey,
  courtEnabled,
  ...scale
}: Omit<ComponentProps<typeof PriceScale>, "usual"> &
  Omit<Parameters<typeof useUsualAuctionRange>[0], "enabled"> & {
    /** Statistiques du tribunal ouvertes, compte connecté, hors annonce exemple. */
    courtEnabled: boolean;
  }) {
  // Sans prix de départ affiché (absent, ou en cours de vérification), pas de prix habituels : ils
  // sont calculés sur ce même prix.
  const enabled = courtEnabled && scale.startingPrice != null;
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const element = ref.current;
    if (near || !enabled || !element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: "800px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [near, enabled]);
  const usual = useUsualAuctionRange({ saleId, access, userKey, enabled: enabled && near });
  return (
    <div ref={ref}>
      <PriceScale {...scale} usual={usual} />
    </div>
  );
}
