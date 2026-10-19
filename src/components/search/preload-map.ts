/**
 * Le module de la carte, chargé par UN SEUL `import()` : `LazyMapPanel` (SearchPage) et le
 * préchargement ci-dessous passent par lui. Deux `import("./MapPanel")` à deux endroits feraient
 * copier le module dans deux fichiers (mesuré : +23 Ko par copie, avec le reste du budget client).
 */
export const loadMapPanelModule = () => import("./MapPanel");

/**
 * Télécharge à l'avance le module de la carte et Mapbox GL (513 Ko) : appelé à l'appui du doigt
 * sur le bouton « Carte » du mobile, il laisse le temps au réseau de travailler pendant que le doigt
 * se relève, au lieu d'attendre le clic pour commencer. Rien n'est téléchargé de plus à l'ouverture,
 * et rien tant que personne ne touche le bouton. Une erreur de réseau ici est sans conséquence :
 * l'ouverture de la carte refait la demande et affiche son propre message.
 */
export function preloadMapModules(): void {
  void loadMapPanelModule().catch(() => undefined);
  void import("mapbox-gl").catch(() => undefined);
}
