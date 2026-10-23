/**
 * Fin annoncée de l'offre de lancement (n° 74) : la date, le délai de préavis. Module pur.
 *
 * La date est enregistrée dans la configuration de l'offre (`app_private.launch_offer.ends_on`, un jour
 * du calendrier de Paris). Elle est ANNONCÉE : elle ne coupe rien, l'administrateur coupe l'offre à la main
 * (docs/runbooks/offre-de-lancement.md).
 */

/** Préavis minimal, en jours de calendrier : la procédure du 20/10/2026 (au moins 30 jours après l'annonce). */
export const LAUNCH_OFFER_MIN_NOTICE_DAYS = 30;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `AAAA-MM-JJ` valide (jour qui existe), sinon `null`. */
export function parseLaunchOfferEndDay(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = DAY.exec(value);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value ? value : null;
}

/** Le jour d'aujourd'hui à Paris, `AAAA-MM-JJ`. */
export function parisToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Jours de calendrier entre aujourd'hui (Paris) et `endsOn` : 0 le jour même, négatif une fois passé. */
export function daysUntilLaunchOfferEnd(endsOn: string, now: Date = new Date()): number {
  const end = Date.parse(`${endsOn}T00:00:00Z`);
  const today = Date.parse(`${parisToday(now)}T00:00:00Z`);
  return Math.round((end - today) / 86_400_000);
}

/** « 30 novembre 2026 ». */
export function launchOfferEndLabel(endsOn: string): string {
  return new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${endsOn}T12:00:00Z`));
}
