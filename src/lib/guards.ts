/**
 * Shared, side-effect-free runtime guards for untrusted JSON-like values
 * (database rows, JSONB columns, request bodies, provider payloads).
 *
 * Several modules used to carry their own copy of these helpers. Copies that
 * were byte-for-byte equivalent were merged under the original name. Copies with
 * a genuinely different contract (fallback value, trimming, numeric strings...)
 * keep a distinct, explicit name so no call site changes behaviour silently.
 */

/** Plain JSON object: not null, not an array. Anything else becomes `{}`. */
export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Plain JSON object: not null, not an array. Anything else becomes `null`. */
export function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Non-blank string, returned untouched (no trimming); otherwise `null`. */
export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** Non-blank string, returned trimmed; otherwise `null`. */
export function trimmedStringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Non-blank string, returned untouched; otherwise the given fallback. */
export function stringValueOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

/**
 * Non-blank string (untouched) or finite number (stringified); otherwise the
 * fallback, or an empty string when the fallback is `null`.
 */
export function stringOrNumberValue(value: unknown, fallback: string | null): string {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback ?? "";
}

/** Non-blank string (trimmed) or finite number (stringified); otherwise `null`. */
export function textValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** Finite number only (no numeric-string coercion); otherwise `null`. */
export function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Finite number, or a non-blank string that parses to a finite number. */
export function parsedNumberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Like {@link parsedNumberValue}, but strings may use a decimal comma: the
 * first comma is read as a decimal point ("12,5" becomes 12.5).
 */
export function decimalCommaNumberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Bounds `value` to `[min, max]`. Callers must pass `min <= max`. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes the five HTML-significant characters for text and quoted attributes. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}
