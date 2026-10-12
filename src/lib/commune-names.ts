/**
 * Commune name normalisation, mirrored by
 * `services/data-pipeline/src/reference_data/names.py` (column
 * `reference_communes.name_normalized`). Keep both implementations in step.
 */
export function normalizeCommuneName(value: string | null | undefined): string {
  if (!value) return "";
  let normalized = value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  for (const [short, long] of [
    ["st ", "saint "],
    ["ste ", "sainte "],
  ] as const) {
    if (normalized.startsWith(short)) normalized = long + normalized.slice(short.length);
    normalized = normalized.replaceAll(` ${short}`, ` ${long}`);
  }
  return normalized;
}

/** Department of a postal code (Corsica: 2A/2B from 200xx/201xx; overseas: 97x). */
export function departmentFromPostalCode(postalCode: string | null | undefined): string | null {
  const code = postalCode?.trim() ?? "";
  if (!/^\d{5}$/.test(code)) return null;
  if (code.startsWith("97")) return code.slice(0, 3);
  if (code.startsWith("20")) return Number(code) < 20200 ? "2A" : "2B";
  return code.slice(0, 2);
}
