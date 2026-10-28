/**
 * Erreurs PostgREST qui disent « cette fonction n'existe pas (encore) » : `PGRST202` (introuvable dans
 * le cache du schéma) et `42883` (`undefined_function` de PostgreSQL). Elles servent à tolérer l'ordre
 * « code déployé avant la migration » : l'appelant revient alors à son comportement d'avant la
 * migration, sans rien exposer de plus.
 */
export function isMissingRpcError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "PGRST202" || code === "42883";
}

/**
 * Table ou fonction inconnue de la base : `PGRST202` / `PGRST205` (introuvable dans le cache du schéma,
 * y compris un cache périmé après une migration), `42883` (`undefined_function`) et `42P01`
 * (`undefined_table`). Règle unique de « la migration n'est pas encore appliquée » (déploiement
 * échelonné) : l'appelant revient à son comportement d'avant la migration.
 */
export function isMissingDatabaseObject(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "PGRST202" || code === "PGRST205" || code === "42883" || code === "42P01";
}
