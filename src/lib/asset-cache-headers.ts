/**
 * Cache navigateur et CDN des fichiers de `public/` dont le nom ne change pas quand le contenu
 * change (`/media/*`, `/brand/*`). Sans règle, Vercel les sert en `max-age=0, must-revalidate` :
 * chaque visite répétée revalide chaque image (aller-retour réseau, 0,5 à 1 Mo de requêtes).
 *
 * Ces fichiers ne portent pas d'empreinte de contenu : un `immutable` d'un an les figerait chez
 * les visiteurs après un remplacement. On borne donc à un jour de fraîcheur, avec une semaine de
 * `stale-while-revalidate` (le navigateur et le CDN servent la copie et la rafraîchissent en
 * arrière-plan). Un fichier remplacé est visible au plus tard au bout d'un jour, une semaine
 * si le visiteur ne revient qu'après ; pour un changement visible tout de suite, renommer le
 * fichier. Les polices (`src/fonts/`) n'en dépendent pas : `next/font` les sert sous
 * `/_next/static/media/` avec une empreinte et un cache `immutable` imposé par Next.js.
 */
export const UNVERSIONED_ASSET_CACHE_CONTROL =
  "public, max-age=86400, stale-while-revalidate=604800";

export const UNVERSIONED_ASSET_SOURCES = ["/media/:path*", "/brand/:path*"] as const;

export type AssetCacheRule = {
  source: string;
  headers: { key: string; value: string }[];
};

export function buildUnversionedAssetCacheRules(): AssetCacheRule[] {
  return UNVERSIONED_ASSET_SOURCES.map((source) => ({
    source,
    headers: [{ key: "Cache-Control", value: UNVERSIONED_ASSET_CACHE_CONTROL }],
  }));
}
