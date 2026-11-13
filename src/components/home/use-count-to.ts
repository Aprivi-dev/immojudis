"use client";

import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "@/hooks/use-media-query";

const DURATION_MS = 700;

/**
 * Valeur affichée qui glisse de la valeur *affichée* (et non de l'ancienne cible : un changement en
 * cours de route ne fait pas sauter le montant) à la nouvelle cible en 700 ms (courbe qui ralentit).
 * Rendu serveur et premier rendu : la cible elle-même. Sans animation quand le visiteur réduit les
 * animations.
 */
export function useCountTo(target: number): number {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    const start = shownRef.current;
    if (start === target) return;
    if (reducedMotion) {
      shownRef.current = target;
      setShown(target);
      return;
    }
    let frame = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - t0) / DURATION_MS);
      const eased = 1 - (1 - progress) ** 3;
      const value = Math.round(start + (target - start) * eased);
      shownRef.current = value;
      setShown(value);
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, reducedMotion]);

  return shown;
}
