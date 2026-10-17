import { useEffect, useRef } from "react";

// Pas de `keydown` : une touche ne suffit pas à vouloir la carte. Tab, qui ne fait que traverser
// la page au clavier, la téléchargerait. Au clavier, le bouton « Afficher la carte » reste le
// moyen explicite de la demander (voir `MapPreview`).
const FIRST_GESTURE_EVENTS = ["pointerdown", "wheel", "touchstart"] as const;

/** Un navigateur occupé finit par lancer le démarrage, même sans moment d'inactivité. */
const IDLE_TIMEOUT_MS = 500;

/**
 * Appelle `callback` une fois le prochain affichage peint : après `requestAnimationFrame`, puis
 * `requestIdleCallback` (repli `setTimeout(…, 0)` : Safari n'a pas `requestIdleCallback`). Le
 * démarrage de la carte (513 Ko, plus d'une seconde de calcul) ne retarde ainsi pas la réponse
 * visuelle au geste qui l'a demandée. Renvoie la fonction qui l'annule.
 */
export function runAfterNextPaint(callback: () => void): () => void {
  let cancelled = false;
  let idleHandle: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = () => {
    if (!cancelled) callback();
  };
  const frame = window.requestAnimationFrame(() => {
    if (cancelled) return;
    if (typeof window.requestIdleCallback === "function") {
      idleHandle = window.requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS });
    } else {
      timer = setTimeout(run, 0);
    }
  });

  return () => {
    cancelled = true;
    window.cancelAnimationFrame(frame);
    if (idleHandle !== undefined) window.cancelIdleCallback(idleHandle);
    if (timer !== undefined) clearTimeout(timer);
  };
}

/**
 * Déclenche `onStart` une seule fois, au premier geste de la personne : `pointerdown`, `wheel` ou
 * `touchstart` n'importe où dans la page (pas `keydown`). Sert à ne télécharger ni initialiser la
 * carte Mapbox GL (513 Ko, plus d'une seconde de calcul sur le fil principal) pour une visite où
 * personne n'interagit : aucun minuteur ni moment d'inactivité ne la lance à la place.
 *
 * `onStart` est différé après la peinture du geste (`runAfterNextPaint`) : le clic, le défilement
 * ou le toucher qui l'a provoqué répond d'abord, la carte se charge ensuite. Un geste sur un
 * élément qui porte `data-map-explicit-start` (le bouton « Afficher la carte »), hors molette, est ignoré : ce
 * bouton démarre la carte lui-même, tout de suite, avec le focus et l'annonce qui vont avec.
 *
 * Rien n'est écouté tant que `enabled` est faux ; une fois `onStart` appelé, l'appelant désactive
 * le hook (`enabled` repasse à faux) pour ne pas le déclencher de nouveau. Un démarrage différé
 * encore en attente est annulé si le hook est désactivé ou démonté. Le survol de la zone de carte
 * et le bouton démarrent aussi la carte : voir `MapPreview`.
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

    let cancelPending: (() => void) | null = null;
    let done = false;
    const start = (event: Event) => {
      if (done) return;
      // La molette sur le bouton reste un geste de carte ; l'appui ou le toucher, une demande
      // explicite que le bouton traite lui-même.
      if (
        event.type !== "wheel" &&
        event.target instanceof Element &&
        event.target.closest("[data-map-explicit-start]")
      ) {
        return;
      }
      done = true;
      removeListeners();
      cancelPending = runAfterNextPaint(() => onStartRef.current());
    };

    for (const eventName of FIRST_GESTURE_EVENTS) {
      window.addEventListener(eventName, start, { passive: true });
    }

    function removeListeners() {
      for (const eventName of FIRST_GESTURE_EVENTS) window.removeEventListener(eventName, start);
    }

    return () => {
      done = true;
      removeListeners();
      cancelPending?.();
    };
  }, [enabled]);
}
