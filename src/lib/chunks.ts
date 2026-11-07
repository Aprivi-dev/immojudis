/** Découpe une liste en paquets (100 par défaut, taille sûre pour un filtre `in`). */
const IN_CHUNK = 100;
export function chunks<T>(values: readonly T[], size = IN_CHUNK): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < values.length; start += size) {
    result.push(values.slice(start, start + size));
  }
  return result;
}
