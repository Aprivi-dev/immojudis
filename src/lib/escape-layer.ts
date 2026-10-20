/**
 * Échap ferme la couche du dessus, pas celles du dessous. Une bulle (pastille, note) qui écoute
 * `Escape` sur le document se refermerait en même temps qu'un dialogue ouvert par-dessus : la
 * personne perdrait la bulle en voulant fermer le dialogue.
 *
 * Un dialogue Radix gère déjà Échap en phase de capture et appelle `preventDefault()` : un
 * événement déjà traité n'est pas pour la bulle. Un dialogue ouvert qui ne contient pas la bulle
 * (même sans `preventDefault()`) l'est tout autant.
 */
const OPEN_DIALOG_SELECTOR = [
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  '[role="dialog"][aria-modal="true"]',
  "dialog[open]",
].join(", ");

export function escapeBelongsToAnotherLayer(event: KeyboardEvent, own: Element | null): boolean {
  if (event.defaultPrevented) return true;
  for (const dialog of document.querySelectorAll(OPEN_DIALOG_SELECTOR)) {
    if (!(own && dialog.contains(own))) return true;
  }
  return false;
}
