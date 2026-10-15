import { isNonProductionVercelDeployment } from "@/lib/site-url";

type IndexingEnv = Readonly<Record<string, string | undefined>>;

/** Valeur de l'en-tête `X-Robots-Tag` envoyée tant que le site n'est pas ouvert à l'indexation. */
export const NOINDEX_ROBOTS_TAG = "noindex, nofollow";

/**
 * Interrupteur d'indexation : le site n'est ouvert aux moteurs de recherche que si
 * `SEO_INDEXING_ENABLED` vaut exactement `true` (espaces autour ignorés). Absente, vide ou
 * avec n'importe quelle autre valeur, la variable ferme l'indexation : on ouvre en le décidant,
 * jamais par oubli.
 */
export function isSeoIndexingEnabled(env: IndexingEnv = process.env): boolean {
  return env.SEO_INDEXING_ENABLED?.trim() === "true";
}

/**
 * Vrai quand les moteurs peuvent indexer ce déploiement : interrupteur ouvert ET déploiement de
 * production. Un aperçu ou un déploiement de développement Vercel reste fermé même si la variable
 * y est posée. Lue à chaque requête (proxy, `robots.txt`), jamais figée au build.
 */
export function isSiteIndexable(env: IndexingEnv = process.env): boolean {
  return isSeoIndexingEnabled(env) && !isNonProductionVercelDeployment(env);
}

/** Valeur de `X-Robots-Tag` à poser sur toute réponse, ou `null` quand le site est indexable. */
export function robotsTagHeaderValue(env: IndexingEnv = process.env): string | null {
  return isSiteIndexable(env) ? null : NOINDEX_ROBOTS_TAG;
}
