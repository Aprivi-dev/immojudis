/** Keep a refresh fluid without reusing rows from another account or access tier. */
export function catalogPlaceholder<T>(
  previous: T | undefined,
  previousKey: readonly unknown[] | undefined,
  accessScope: string | null,
): T | undefined {
  return accessScope && previousKey?.[2] === accessScope ? previous : undefined;
}
