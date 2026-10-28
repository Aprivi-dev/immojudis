import type { KeyboardEvent } from "react";

/**
 * Clavier d'un `role="radiogroup"` fait de boutons `role="radio"` : les flèches, Début et Fin
 * déplacent le choix (le focus et la sélection avancent ensemble, comme pour des boutons radio
 * natifs). À poser sur le conteneur du groupe ; chaque radio ne garde un `tabIndex` à 0 que si elle
 * est cochée (ou la première, quand aucune ne l'est), pour qu'une seule d'entre elles soit un arrêt
 * de Tab.
 */
export function onRadioGroupKeyDown(event: KeyboardEvent<HTMLElement>): void {
  const origin = event.target;
  if (!(origin instanceof HTMLElement)) return;
  const current = origin.closest<HTMLElement>('[role="radio"]');
  if (!current || !event.currentTarget.contains(current)) return;
  const radios = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]'));
  const index = radios.indexOf(current);
  if (index < 0 || radios.length === 0) return;

  let next: number | null = null;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    next = (index + 1) % radios.length;
  } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    next = (index - 1 + radios.length) % radios.length;
  } else if (event.key === "Home") {
    next = 0;
  } else if (event.key === "End") {
    next = radios.length - 1;
  }
  if (next == null) return;

  event.preventDefault();
  radios[next].focus();
  radios[next].click();
}
