"use client";

import { useEffect, useRef, useState } from "react";

const DURATION_MS = 700;

/**
 * Valeur affichée qui glisse de l'ancienne à la nouvelle cible en 700 ms (courbe qui ralentit).
 * Rendu serveur et premier rendu : la cible elle-même. Sans animation quand le visiteur réduit les
 * animations.
 */
export function useCountTo(target: number): number {
  const [shown, setShown] = useState(target);
  const from = useRef(target);

  useEffect(() => {
    const start = from.current;
    from.current = target;
    if (start === target) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setShown(target);
      return;
    }
    let frame = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - t0) / DURATION_MS);
      const eased = 1 - (1 - progress) ** 3;
      setShown(Math.round(start + (target - start) * eased));
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target]);

  return shown;
}
