import { useEffect, useRef } from "react";

/** Au plus tard, délai (ms) laissé à l'inactivité du navigateur une fois la liste affichée. */
export const DEFERRED_START_IDLE_TIMEOUT_MS = 1500;
/** Repli quand `requestIdleCallback` n'existe pas (Safari). */
export const DEFERRED_START_FALLBACK_MS = 300;
/** Plafond (ms) même si la liste n'est jamais déclarée prête. */
export const DEFERRED_START_MAX_WAIT_MS = 5000;

const FIRST_GESTURE_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

/**
 * Déclenche `onStart` une seule fois, après le premier affichage de la liste : au prochain
 * moment d'inactivité du navigateur (repli : un court délai), plus tôt au premier geste de la
 * personne, et au plus tard après `DEFERRED_START_MAX_WAIT_MS`. Sert à ne pas initialiser la
 * carte Mapbox pendant l'hydratation, qui bloquerait le fil principal.
 *
 * Rien ne se passe tant que `enabled` est faux ; une fois `onStart` appelé, l'appelant désactive
 * le hook (`enabled` repasse à faux) pour ne pas le déclencher de nouveau.
 */
export function useDeferredStart({
  enabled,
  listReady,
  onStart,
}: {
  enabled: boolean;
  listReady: boolean;
  onStart: () => void;
}) {
  const onStartRef = useRef(onStart);
  useEffect(() => {
    onStartRef.current = onStart;
  }, [onStart]);

  useEffect(() => {
    if (!enabled) return;

    let done = false;
    let idleHandle: number | null = null;
    let idleTimer: number | null = null;
    const start = () => {
      if (done) return;
      done = true;
      cleanup();
      onStartRef.current();
    };

    for (const eventName of FIRST_GESTURE_EVENTS) {
      window.addEventListener(eventName, start, { passive: true, once: true });
    }
    const maxWaitTimer = window.setTimeout(start, DEFERRED_START_MAX_WAIT_MS);

    if (listReady) {
      if (typeof window.requestIdleCallback === "function") {
        idleHandle = window.requestIdleCallback(start, {
          timeout: DEFERRED_START_IDLE_TIMEOUT_MS,
        });
      } else {
        idleTimer = window.setTimeout(start, DEFERRED_START_FALLBACK_MS);
      }
    }

    function cleanup() {
      for (const eventName of FIRST_GESTURE_EVENTS) window.removeEventListener(eventName, start);
      window.clearTimeout(maxWaitTimer);
      if (idleTimer != null) window.clearTimeout(idleTimer);
      if (idleHandle != null && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idleHandle);
      }
    }

    return () => {
      done = true;
      cleanup();
    };
  }, [enabled, listReady]);
}
