/**
 * Identifiant UUID (ventes, comptes, alertes, notifications…), seule règle de l'application : tout
 * UUID que Postgres accepte, en hexadécimal, sans exiger de version ni de variante.
 */
export const UUID_SOURCE = "[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}";

/** Une chaîne qui n'est qu'un UUID (majuscules acceptées). */
export const UUID_PATTERN = new RegExp(`^${UUID_SOURCE}$`, "i");

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}
