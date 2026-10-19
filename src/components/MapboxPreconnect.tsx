import { preconnect } from "react-dom";
import { getMapboxAccessToken } from "@/lib/mapbox";

/** Origine des vignettes cartographiques (API d'images statiques) et des données de la carte. */
export const MAPBOX_API_ORIGIN = "https://api.mapbox.com";

/**
 * Prépare la connexion (DNS, TCP, TLS) vers Mapbox : les vignettes des cartes sans photo
 * (`mapboxStaticImageUrl`) sont des `<img>` qui partent de `api.mapbox.com`, et la carte du
 * catalogue y charge son style et ses tuiles. Le navigateur n'attend plus d'avoir lu le HTML
 * jusqu'à la première vignette pour ouvrir la connexion. Rien n'est émis sans jeton Mapbox
 * (`NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN`) : aucune requête ne partirait vers Mapbox.
 *
 * Pas de `crossOrigin`, comme `PhotoMirrorPreconnect` : une `<img>` sans attribut `crossorigin`
 * n'emploie pas la connexion qu'ouvrirait un `crossorigin`. La carte, chargée au premier geste
 * (voir `MapPanel`), ouvre ses propres connexions CORS quand elle démarre.
 *
 * À placer dans un layout, pas dans la page : voir `src/app/sales/layout.tsx`.
 */
export function MapboxPreconnect() {
  if (getMapboxAccessToken()) preconnect(MAPBOX_API_ORIGIN);
  return null;
}
