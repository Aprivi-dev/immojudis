import { preconnect } from "react-dom";
import { photoMirrorOrigin } from "@/lib/photo-mirror";

/**
 * Prépare la connexion (DNS, TCP, TLS) vers le stockage des copies hébergées des photos : le
 * navigateur n'attend plus d'avoir lu le HTML jusqu'à la première `<img>` pour l'ouvrir. Rien
 * n'est émis si l'interrupteur `NEXT_PUBLIC_PHOTO_MIRROR` est éteint ou si Supabase n'est pas
 * configuré.
 *
 * API de React recommandée par Next (`ReactDOM.preconnect`, section « Resource hints » de la doc de
 * `generateMetadata`) ; rien n'est rendu. Next place l'indication là où elle sert le plus tôt : dans
 * l'en-tête HTTP `Link: <origine>; rel=preconnect` d'une page rendue à la demande (/sales), dans le
 * `<head>` d'une page statique (la fiche). Pas de `crossOrigin` : une `<img>` sans attribut
 * `crossorigin` charge l'image sans CORS, sur une connexion distincte de celle des requêtes CORS
 * (polices, `fetch`) ; un `crossorigin` ouvrirait une connexion que les images n'emploieraient pas.
 *
 * À placer dans un layout, pas dans la page : voir `src/app/sales/layout.tsx`.
 */
export function PhotoMirrorPreconnect() {
  const origin = photoMirrorOrigin();
  if (origin) preconnect(origin);
  return null;
}
