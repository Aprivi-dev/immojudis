/**
 * Dates affichées, toujours à l'heure de Paris : le serveur (Vercel) est en UTC et le navigateur
 * peut être ailleurs. Un jour civil « AAAA-MM-JJ » est lu à minuit UTC, soit 1 h ou 2 h à Paris le
 * même jour : il n'est jamais décalé. Une valeur absente ou illisible rend `fallback`, qui peut être
 * `null` quand l'appelant omet la date plutôt que d'écrire un texte de repli.
 *
 * Seule règle du « 1er » : les formats où le mois s'écrit en toutes lettres écrivent le premier du
 * mois « 1er » (« 1er novembre 2026 ») ; les formats abrégés et numériques gardent « 1 »
 * (« 1 nov. 2026 », « 01/11/2026 »).
 *
 * L'heure des mêmes formats s'écrit à la française, « 9 h 30 » (décision du 14/11/2026) ; les formats
 * abrégés et numériques, réservés aux tableaux de l'administration, gardent « 09:30 ».
 *
 * Le fuseau est écrit en toutes lettres, comme `PARIS_TIME_ZONE` (`paris-time.ts`) : importer ce module
 * ici change le découpage de Turbopack et alourdit le JavaScript client total d'environ 127 ko (mesuré
 * le 13/11/2026), au-delà du plafond de `scripts/check-build-budgets.mjs`.
 */
function formatParisDate<F extends string | null>(
  value: string | null | undefined,
  options: Intl.DateTimeFormatOptions,
  fallback: F,
): string | F {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  const format = new Intl.DateTimeFormat("fr-FR", { ...options, timeZone: "Europe/Paris" });
  if (options.month !== "long") return format.format(date);
  return format
    .formatToParts(date)
    .map(({ type, value: part }) => frenchDatePart(type, part))
    .join("");
}

/** Une partie d'une date en toutes lettres : « 1er », et l'heure écrite « 9 h 30 ». */
function frenchDatePart(type: Intl.DateTimeFormatPartTypes, part: string): string {
  if (type === "day" && part === "1") return "1er";
  if (type === "hour") return String(Number(part));
  if (type === "literal" && part === ":") return " h ";
  return part;
}

/** « 9 h 30 » : une heure lue dans un texte (heure et minutes déjà séparées). */
export function formatClock(hour: string | number, minute: string | number): string {
  return `${Number(hour)} h ${String(minute).padStart(2, "0")}`;
}

/** « 5 novembre 2026 ». */
export function formatDate<F extends string | null = string>(
  value: string | null | undefined,
  fallback: F = "Date à confirmer" as F,
): string | F {
  return formatParisDate(value, { day: "numeric", month: "long", year: "numeric" }, fallback);
}

/** « 5 novembre », sans l'année. */
export function formatDayLongMonth<F extends string | null = string>(
  value: string | null | undefined,
  fallback: F = "Date à confirmer" as F,
): string | F {
  return formatParisDate(value, { day: "numeric", month: "long" }, fallback);
}

/** « 5 novembre 2026 à 14 h 30 ». */
export function formatDateTime<F extends string | null = string>(
  value: string | null | undefined,
  fallback: F = "—" as F,
): string | F {
  return formatParisDate(
    value,
    { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" },
    fallback,
  );
}

/** « jeudi 5 novembre 2026 ». */
export function formatWeekdayDate<F extends string | null = string>(
  value: string | null | undefined,
  fallback: F = "Date à confirmer" as F,
): string | F {
  return formatParisDate(
    value,
    { weekday: "long", day: "numeric", month: "long", year: "numeric" },
    fallback,
  );
}

/** « jeudi ». */
export function formatWeekday<F extends string | null = string>(
  value: string | null | undefined,
  fallback: F = "—" as F,
): string | F {
  return formatParisDate(value, { weekday: "long" }, fallback);
}

/** « 5 nov. 2026 ». */
export function formatShortDate<F extends string | null = string>(
  value: string | null | undefined,
  fallback: F = "—" as F,
): string | F {
  return formatParisDate(value, { dateStyle: "medium" }, fallback);
}

/** « 5 nov. 2026, 14:30 ». */
export function formatShortDateTime<F extends string | null = string>(
  value: string | null | undefined,
  fallback: F = "—" as F,
): string | F {
  return formatParisDate(value, { dateStyle: "medium", timeStyle: "short" }, fallback);
}

/** « 05/11/2026 ». */
export function formatNumericDate<F extends string | null = string>(
  value: string | null | undefined,
  fallback: F = "—" as F,
): string | F {
  return formatParisDate(value, { dateStyle: "short" }, fallback);
}

/** « 05/11/2026 14:30 ». */
export function formatNumericDateTime<F extends string | null = string>(
  value: string | null | undefined,
  fallback: F = "—" as F,
): string | F {
  return formatParisDate(value, { dateStyle: "short", timeStyle: "short" }, fallback);
}

/** « 5 nov. », sans l'année. */
export function formatDayMonth<F extends string | null = string>(
  value: string | null | undefined,
  fallback: F = "—" as F,
): string | F {
  return formatParisDate(value, { day: "numeric", month: "short" }, fallback);
}
