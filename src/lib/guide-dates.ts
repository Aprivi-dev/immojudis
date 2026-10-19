/**
 * Date de la dernière révision éditoriale du guide `/ventes-immobilieres-judiciaires`
 * (AAAA-MM-JJ). Source unique : elle alimente la mention « Mis à jour le » de la page, le
 * `dateModified` de ses données structurées (`src/app/ventes-immobilieres-judiciaires/
 * resources-guide.tsx`) et la date de cette page dans le sitemap (`src/app/sitemap.ts`). À changer
 * à la main, et seulement quand le contenu du guide change sur le fond (ni la date du build, ni
 * celle du jour).
 *
 * Module sans dépendance, pour que le sitemap l'importe sans charger le composant du guide.
 */
export const GUIDE_LAST_UPDATED = "2026-10-13";
