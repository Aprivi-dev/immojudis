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
export const GUIDE_LAST_UPDATED = "2026-10-28";

/**
 * Temps de lecture du guide, en minutes : source unique de la mention de la page
 * (`resources-guide.tsx`) et de la carte du guide sur `/ressources` (`EXISTING_GUIDE` de
 * `src/lib/resource-articles.ts`). Le texte du guide est du JSX, que seul un rendu complet permet
 * de compter : le test du guide recompte les mots de la page (230 mots par minute) et échoue si
 * cette valeur s'en écarte de plus d'une minute. À mettre à jour avec `GUIDE_LAST_UPDATED` quand
 * le contenu du guide change sur le fond.
 */
export const GUIDE_READING_MINUTES = 26;
