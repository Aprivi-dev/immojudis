export type DirectorySearch = {
  saleId?: string;
  bar?: string;
  city?: string;
  department?: string;
};

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Reads the directory filters from raw URL parameters (server page and tests). */
export function validateDirectorySearch(search: Record<string, unknown>): DirectorySearch {
  return {
    saleId: stringValue(search.saleId),
    bar: stringValue(search.bar),
    city: stringValue(search.city),
    department: stringValue(search.department),
  };
}
