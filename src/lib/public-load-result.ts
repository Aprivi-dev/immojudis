/**
 * Lecture publique qui ne lève pas : `ok` avec ce qu'elle a lu, ou `error` (base en panne). Pour les
 * pages, le sitemap et les index qui doivent rester disponibles ; l'appelant ne confond jamais
 * `error` avec une liste vide.
 */
export type PublicLoadResult<T extends object> = ({ status: "ok" } & T) | { status: "error" };

/** Lance `load` ; une erreur est tracée (`console.warn(warning, error)`) et rendue `error`. */
export async function tryPublicLoad<T extends object>(
  warning: string,
  load: () => Promise<T>,
): Promise<PublicLoadResult<T>> {
  try {
    return { status: "ok", ...(await load()) };
  } catch (error) {
    console.warn(warning, error);
    return { status: "error" };
  }
}
