"use client";

import { useHasHydrated } from "@/hooks/use-has-hydrated";

// Petit calcul du jour à Paris, propre à ce composant : `parisDateKey` et `calendarDaysBetween` de
// `@/lib/sale-countdown` tirent tout le module (fenêtres de vente, fuseaux) dans le JavaScript
// initial de la page. Un test les compare pour que les deux restent d'accord.
const PARIS_DAY = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "Europe/Paris",
  year: "numeric",
});

/** Le jour (AAAA-MM-JJ) de `value` à Paris. */
export function parisDay(value: Date): string {
  const fields = Object.fromEntries(PARIS_DAY.formatToParts(value).map((p) => [p.type, p.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

/** Nombre de jours calendaires de `from` à `to` (AAAA-MM-JJ) ; `null` si une date est illisible. */
export function daysBetween(from: string, to: string): number | null {
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  return Number.isFinite(days) ? Math.round(days) : null;
}

/**
 * Un jour d'audience : sa date en toutes lettres, suivie de « (aujourd’hui) » ou « (demain) » une
 * fois la page montée dans le navigateur. La page est produite à l'avance et servie jusqu'à une
 * heure : « aujourd'hui » calculé par le serveur serait faux pour une partie des lecteurs. Le HTML
 * du serveur ne porte donc que la date ; le repère relatif s'ajoute avec l'horloge du visiteur (le
 * jour à Paris, comme les dates de la page).
 */
export function RelativeDay({ dayKey, label }: { dayKey: string; label: string }) {
  const mounted = useHasHydrated();
  const offset = mounted ? daysBetween(parisDay(new Date()), dayKey) : null;
  const suffix = offset === 0 ? " (aujourd’hui)" : offset === 1 ? " (demain)" : "";
  return (
    <time dateTime={dayKey}>
      {label}
      {suffix}
    </time>
  );
}
