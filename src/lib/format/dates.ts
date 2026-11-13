/**
 * Dates affichées, toujours à l'heure de Paris : le serveur (Vercel) est en UTC et le navigateur
 * peut être ailleurs. Un jour civil « AAAA-MM-JJ » est lu à minuit UTC, soit 1 h ou 2 h à Paris le
 * même jour : il n'est jamais décalé. Une valeur absente ou illisible rend `fallback`.
 *
 * Le fuseau est écrit en toutes lettres, comme `PARIS_TIME_ZONE` (`paris-time.ts`) : importer ce module
 * ici change le découpage de Turbopack et alourdit le JavaScript client total d'environ 127 ko (mesuré
 * le 13/11/2026), au-delà du plafond de `scripts/check-build-budgets.mjs`.
 */
function formatParisDate(
  value: string | null | undefined,
  options: Intl.DateTimeFormatOptions,
  fallback: string,
): string {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat("fr-FR", { ...options, timeZone: "Europe/Paris" }).format(date);
}

/** « 5 novembre 2026 ». */
export function formatDate(
  value: string | null | undefined,
  fallback = "Date à confirmer",
): string {
  return formatParisDate(value, { day: "numeric", month: "long", year: "numeric" }, fallback);
}

/** « 5 novembre 2026 à 14:30 ». */
export function formatDateTime(value: string | null | undefined, fallback = "—"): string {
  return formatParisDate(
    value,
    { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" },
    fallback,
  );
}

/** « 5 nov. 2026 ». */
export function formatShortDate(value: string | null | undefined, fallback = "—"): string {
  return formatParisDate(value, { dateStyle: "medium" }, fallback);
}

/** « 5 nov. 2026, 14:30 ». */
export function formatShortDateTime(value: string | null | undefined, fallback = "—"): string {
  return formatParisDate(value, { dateStyle: "medium", timeStyle: "short" }, fallback);
}

/** « 05/11/2026 ». */
export function formatNumericDate(value: string | null | undefined, fallback = "—"): string {
  return formatParisDate(value, { dateStyle: "short" }, fallback);
}

/** « 05/11/2026 14:30 ». */
export function formatNumericDateTime(value: string | null | undefined, fallback = "—"): string {
  return formatParisDate(value, { dateStyle: "short", timeStyle: "short" }, fallback);
}

/** « 5 nov. », sans l'année. */
export function formatDayMonth(value: string | null | undefined, fallback = "—"): string {
  return formatParisDate(value, { day: "numeric", month: "short" }, fallback);
}
