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

// Clés de la liste et du total du catalogue (serveur et navigateur), sous leur ancien nom : elles
// viennent de la fabrique unique `@/lib/query-keys`.
export {
  salesSearch as salesSearchQueryKey,
  salesSearchCount as salesSearchCountQueryKey,
} from "@/lib/query-keys";
