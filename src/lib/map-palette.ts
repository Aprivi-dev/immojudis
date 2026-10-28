/**
 * Couleurs des couches de la carte de `/sales`. Mapbox ne lit pas les variables CSS : elles sont
 * recopiées ici, et `map-palette.test.ts` les compare aux jetons de `src/styles.css` pour qu'un
 * jeton modifié ne laisse pas la carte sur l'ancienne couleur.
 */
export const MAP_PALETTE = {
  /** `--brand-navy` : vente isolée, texte des regroupements, contours. */
  navy: "#132238",
  /** `--gold` : regroupements, anneau et pictogramme de pépite. */
  gold: "#c98d45",
  /** `--gold-soft` : trait de l'état sélectionné (4,92:1 sur blanc, contre 2,85:1 pour `--gold`). */
  goldSoft: "#9c642b",
  white: "#ffffff",
} as const;

function withAlpha(hex: string, alpha: number): string {
  const [red, green, blue] = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
  return `rgba(${red},${green},${blue},${alpha})`;
}

/** Fond du point sélectionné : l'or du jeton, à 25 %. */
export const MAP_ACTIVE_FILL = withAlpha(MAP_PALETTE.gold, 0.25);
/** Halo discret autour du prix, pour qu'il reste lisible. */
export const MAP_PRICE_HALO = withAlpha(MAP_PALETTE.navy, 0.28);
