import { useEffect, useRef } from "react";

const FIRST_GESTURE_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

/**
 * Déclenche `onStart` une seule fois, au premier geste de la personne : `pointerdown`, `keydown`,
 * `wheel` ou `touchstart` n'importe où dans la page. Sert à ne télécharger ni initialiser la
 * carte Mapbox GL (513 Ko, plus d'une seconde de calcul sur le fil principal) pour une visite où
 * personne n'interagit : aucun minuteur ni moment d'inactivité ne la lance à la place.
 *
 * Rien n'est écouté tant que `enabled` est faux ; une fois `onStart` appelé, l'appelant désactive
 * le hook (`enabled` repasse à faux) pour ne pas le déclencher de nouveau. Le survol ou le focus
 * de la zone de carte, et le bouton « Afficher la carte », démarrent aussi la carte : voir
 * `MapPreview`.
 */
export function useFirstGestureStart({
  enabled,
  onStart,
}: {
  enabled: boolean;
  onStart: () => void;
}) {
  const onStartRef = useRef(onStart);
  useEffect(() => {
    onStartRef.current = onStart;
  }, [onStart]);

  useEffect(() => {
    if (!enabled) return;

    let done = false;
    const start = () => {
      if (done) return;
      done = true;
      cleanup();
      onStartRef.current();
    };

    for (const eventName of FIRST_GESTURE_EVENTS) {
      window.addEventListener(eventName, start, { passive: true, once: true });
    }

    function cleanup() {
      for (const eventName of FIRST_GESTURE_EVENTS) window.removeEventListener(eventName, start);
    }

    return () => {
      done = true;
      cleanup();
    };
  }, [enabled]);
}
