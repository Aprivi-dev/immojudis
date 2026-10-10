/** Keep a refresh fluid without reusing rows from another account or access tier. */
export function catalogPlaceholder<T>(
  previous: T | undefined,
  previousKey: readonly unknown[] | undefined,
  accessScope: string | null,
): T | undefined {
  return accessScope && previousKey?.[2] === accessScope ? previous : undefined;
}

/** Access scope of a signed-out visitor: the one the server renders and dehydrates. */
export const ANONYMOUS_PREVIEW_SCOPE = "anonymous:preview";

/** React Query keys of the catalogue list and count, shared by server and client. */
export function salesSearchQueryKey(signature: string, scope: string | null) {
  return ["sales-search", signature, scope] as const;
}

export function salesSearchCountQueryKey(signature: string, scope: string | null) {
  return ["sales-search-count", signature, scope] as const;
}
