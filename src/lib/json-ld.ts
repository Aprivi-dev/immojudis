/** Serialise structured data for an inline `<script type="application/ld+json">`. */
export function jsonLdString(data: unknown): string {
  // `<` is escaped so a value such as "</script>" cannot close the tag; the
  // line separators are escaped because they break some JavaScript parsers.
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
