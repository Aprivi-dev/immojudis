/**
 * La promesse, ou l'erreur `onTimeout()` si elle n'aboutit pas en `timeoutMs` ; le minuteur est
 * libéré dans les deux cas. La promesse d'origine n'est pas annulée : son résultat est ignoré.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
