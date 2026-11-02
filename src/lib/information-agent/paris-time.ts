/**
 * Heure de Paris, module pur (aucun accès réseau ni base), utilisable côté serveur comme dans les règles
 * pures du pilote automatique.
 */
/**
 * Début du jour (heure de Paris) qui contient `now`. Le plafond quotidien suit le jour calendaire
 * français, pas une fenêtre glissante de 24 heures.
 */
export function startOfParisDay(now: Date): Date {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value);
  const localAsUtc = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  );
  const offsetMs = localAsUtc - Math.floor(now.getTime() / 1000) * 1000;
  return new Date(Date.UTC(part("year"), part("month") - 1, part("day")) - offsetMs);
}
