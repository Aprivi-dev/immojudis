/**
 * Mois civil à l'heure de Paris (Europe/Paris).
 *
 * Les compteurs mensuels (rapports, exports) se remettent à zéro le 1er du mois à 00 h 00 heure de
 * Paris, et non à minuit UTC (01 h ou 02 h à Paris). Module pur, sans import serveur : utilisable
 * côté serveur, dans le navigateur et dans les tests.
 */

import { parisDateKey, parisMidnightUtc } from "@/lib/paris-time";

/** Instant UTC du 1er du mois (0 h 00, heure de Paris) de `year`/`month` (1-12 ; 13 : janvier suivant). */
function parisMonthStart(year: number, month: number): Date {
  const first = new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10);
  return parisMidnightUtc(first);
}

export type ParisMonthWindow = {
  /** Début du mois (1er, 0 h 00 heure de Paris), en ISO UTC. */
  periodStart: string;
  /** Début du mois suivant : instant de la remise à zéro du compteur, en ISO UTC. */
  periodEnd: string;
};

export function parisMonthWindow(now: Date = new Date()): ParisMonthWindow {
  const [year, month] = parisDateKey(now).split("-").map(Number);
  return {
    periodStart: parisMonthStart(year, month).toISOString(),
    periodEnd: parisMonthStart(year, month + 1).toISOString(),
  };
}
