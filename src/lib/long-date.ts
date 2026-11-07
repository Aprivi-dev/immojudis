/** Date longue en français (fuseau de Paris) ; `null` si absente ou invalide. */
import { parseTimestamp as timestamp } from "@/lib/timestamp";

export function formatLongParisDate(value: string | null): string | null {
  const time = timestamp(value);
  if (time == null) return null;
  return new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Paris",
  }).format(new Date(time));
}
