export type FlattenedValue = {
  path: string;
  value: unknown;
};

/**
 * Flattens nested source blocks while preserving the original property path.
 * Arrays use bracket notation so callers can keep their existing labels.
 */
export function flattenKeyValues(value: unknown, path = ""): FlattenedValue[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => flattenPrimitiveOrObject(item, `${path}[${index}]`));
  }

  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
    flattenPrimitiveOrObject(item, path ? `${path}.${key}` : key),
  );
}

function flattenPrimitiveOrObject(value: unknown, path: string): FlattenedValue[] {
  if (value && typeof value === "object") return flattenKeyValues(value, path);
  return [{ path, value }];
}

export function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function excerpt(value: string, maxLength = 180): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 3).trim()}...` : text;
}
