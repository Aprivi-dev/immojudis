/** Durée laissée au défilement doux avant de vérifier que la carte est bien au centre. */
const SMOOTH_SCROLL_SETTLE_MS = 900;

/**
 * Fait défiler la liste jusqu'à la carte `sale-card-<id>` (sélection depuis la carte Mapbox).
 *
 * Les cartes hors écran sont en `content-visibility: auto` : leur hauteur est estimée tant
 * qu'elles n'ont pas été affichées, et elle se corrige quand le défilement les croise. La cible
 * calculée au départ peut donc être un peu décalée ; après le défilement doux, on recentre d'un
 * coup si la carte s'est éloignée du centre de l'écran.
 */
export function scrollToSaleCard(saleId: string) {
  const find = () => document.getElementById(`sale-card-${saleId}`);
  find()?.scrollIntoView({ block: "center", behavior: "smooth" });

  window.setTimeout(() => {
    const card = find();
    if (!card) return;
    const { top, bottom } = card.getBoundingClientRect();
    const offCenter = Math.abs((top + bottom) / 2 - window.innerHeight / 2);
    if (offCenter > window.innerHeight * 0.25) {
      card.scrollIntoView({ block: "center", behavior: "instant" });
    }
  }, SMOOTH_SCROLL_SETTLE_MS);
}
