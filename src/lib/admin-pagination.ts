/**
 * Pagination commune des listes de l'administration (offset / limit / total). Aucun import de zod
 * ni de code serveur : ce module est partagé avec les composants client.
 */
export const ADMIN_PAGE_SIZE = 50;
export const ADMIN_PAGE_MAX_LIMIT = 100;
export const ADMIN_PAGE_MAX_OFFSET = 100_000;

export type AdminPageMeta = {
  offset: number;
  limit: number;
  /** Nombre total de lignes correspondant au filtre, toutes pages confondues. */
  total: number;
  hasMore: boolean;
};

export function adminPageMeta({
  offset,
  limit,
  total,
}: {
  offset: number;
  limit: number;
  total: number;
}): AdminPageMeta {
  return { offset, limit, total, hasMore: offset + limit < total };
}

/**
 * Total d'une liste, ou `null` quand la réponse n'en a pas (serveur ancien, réponse tronquée) : on
 * n'écrit alors ni « sur … » ni « page NaN sur NaN », seulement les lignes reçues.
 */
export function adminKnownTotal(total: number): number | null {
  return Number.isFinite(total) ? total : null;
}

/** « sur 230 » à la suite d'un compte de lignes affichées, ou rien quand le total est inconnu. */
export function adminOfTotal(total: number): string {
  const known = adminKnownTotal(total);
  return known == null ? "" : ` sur ${known}`;
}

/** « 51–100 sur 230 », ou « 0 sur 0 » pour une liste vide. */
export function adminPageRange({
  offset,
  shown,
  total,
}: {
  offset: number;
  shown: number;
  total: number;
}): string {
  if (!total || !shown) return `0 sur ${total}`;
  return `${offset + 1}–${offset + shown} sur ${total}`;
}

/** Offset de la page précédente ou suivante, borné à [0, dernier offset valide]. */
export function adminPreviousOffset(offset: number, limit: number): number {
  return Math.max(0, offset - limit);
}

export function adminNextOffset(offset: number, limit: number, total: number): number {
  return offset + limit < total ? offset + limit : offset;
}

/** Offset valide le plus proche quand le total a diminué (lignes traitées pendant la revue). */
export function adminClampOffset(offset: number, limit: number, total: number): number {
  if (total <= 0 || offset < total) return offset;
  return Math.max(0, Math.floor((total - 1) / limit) * limit);
}
