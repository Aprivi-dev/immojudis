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
