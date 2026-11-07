/** Famille de bien (maison, appartement, immeuble, terrain) tirée d'un libellé libre. */
export function propertyTypeFamily(value: string | null | undefined): string {
  const text = (value ?? "").toLowerCase();
  if (/maison|house|villa|pavillon/.test(text)) return "house";
  if (/appartement|apartment|studio|t1|t2|t3|t4/.test(text)) return "apartment";
  if (/immeuble|building/.test(text)) return "building";
  if (/terrain|land/.test(text)) return "land";
  return text.trim() || "unknown";
}
