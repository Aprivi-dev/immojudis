"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { FocusEvent } from "react";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener?.("change", onChange);
  return () => query.removeEventListener?.("change", onChange);
}

function reducedMotionNow(): boolean {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.(REDUCED_MOTION).matches);
}

/**
 * Démonstration qui défile seule, sans jamais gêner la lecture (WCAG 2.2.2, RGAA 13.8) :
 *  - un seul tour : elle s'arrête sur la dernière étape ;
 *  - elle attend tant que le visiteur survole la zone ou y a le focus (`handlers`) ;
 *  - elle s'arrête pour de bon au premier toucher (`onTouchStart`) ou au premier choix (`stop`) ;
 *  - `togglePause` : le bouton « Mettre en pause l'animation » ;
 *  - rien ne défile quand le visiteur réduit les animations.
 * `active` : la démonstration ne démarre que lorsque la zone est à l'écran.
 */
export function useDemoLoop({
  steps,
  firstMs,
  stepMs,
  active = true,
}: {
  steps: number;
  firstMs: number;
  stepMs: number;
  active?: boolean;
}) {
  const reduced = useSyncExternalStore(subscribeReducedMotion, reducedMotionNow, () => false);
  const [step, setStep] = useState(0);
  const [paused, setPaused] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);

  // Le défilement peut encore avancer (le bouton de pause n'a de sens que dans ce cas).
  const running = !stopped && !reduced && step < steps - 1;
  const waiting = paused || hovered || focused || !active;

  useEffect(() => {
    if (!running || waiting) return;
    const timer = window.setTimeout(
      () => setStep((current) => current + 1),
      step === 0 ? firstMs : stepMs,
    );
    return () => window.clearTimeout(timer);
  }, [running, waiting, step, firstMs, stepMs]);

  const stop = useCallback(() => setStopped(true), []);
  const togglePause = useCallback(() => setPaused((current) => !current), []);
  const handlers = {
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
    onFocus: () => setFocused(true),
    onBlur: (event: FocusEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
    },
    onTouchStart: stop,
  };

  return { step, running, paused, stopped, stop, togglePause, handlers };
}
