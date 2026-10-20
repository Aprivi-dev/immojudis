"use client";

import { useHasHydrated } from "@/hooks/use-has-hydrated";
import { calendarDaysBetween, parisDateKey } from "@/lib/sale-countdown";

/**
 * Un jour d'audience : sa date en toutes lettres, suivie de « (aujourd’hui) » ou « (demain) » une
 * fois la page montée dans le navigateur. La page est produite à l'avance et servie jusqu'à une
 * heure : « aujourd'hui » calculé par le serveur serait faux pour une partie des lecteurs. Le HTML
 * du serveur ne porte donc que la date ; le repère relatif s'ajoute avec l'horloge du visiteur (le
 * jour à Paris, comme les dates de la page).
 */
export function RelativeDay({ dayKey, label }: { dayKey: string; label: string }) {
  const mounted = useHasHydrated();
  const offset = mounted ? calendarDaysBetween(parisDateKey(new Date()), dayKey) : null;
  const suffix = offset === 0 ? " (aujourd’hui)" : offset === 1 ? " (demain)" : "";
  return (
    <time dateTime={dayKey}>
      {label}
      {suffix}
    </time>
  );
}
