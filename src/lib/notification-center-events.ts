/**
 * Demande d'ouverture de la cloche des notifications depuis une autre partie de la page (par
 * exemple l'action « Voir » d'un message). La cloche vit dans l'en-tête : un événement de la
 * fenêtre évite de faire remonter son état jusqu'à toutes les pages.
 */
const OPEN_NOTIFICATIONS_EVENT = "immojudis:open-notifications";

/** Point de rupture « lg » de Tailwind : au-dessus, la cloche est dans la barre ; sinon, dans le menu. */
const DESKTOP_HEADER_QUERY = "(min-width: 1024px)";

export function requestOpenNotifications(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OPEN_NOTIFICATIONS_EVENT));
}

/** Écoute les demandes d'ouverture ; renvoie la fonction qui retire l'écoute. */
export function onOpenNotificationsRequest(listener: () => void): () => void {
  window.addEventListener(OPEN_NOTIFICATIONS_EVENT, listener);
  return () => window.removeEventListener(OPEN_NOTIFICATIONS_EVENT, listener);
}

/** Vrai quand la barre d'en-tête (et sa cloche) est affichée, faux quand seul le menu mobile l'est. */
export function isDesktopHeader(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia(DESKTOP_HEADER_QUERY).matches;
}
