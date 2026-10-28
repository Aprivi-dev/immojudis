/**
 * Libellés et formats de la vue admin « Inscriptions », sans dépendance serveur (lus par la page et
 * par `admin-signups.ts`).
 */

import { ANALYSIS_TRIAL_DAYS } from "@/lib/analysis-offer";

export const ADMIN_SIGNUP_ACCESS = [
  "trial",
  "trial_extended",
  "analyse_paid",
  "analyse_manual",
  "premium",
  "decouverte",
] as const;
export type AdminSignupAccess = (typeof ADMIN_SIGNUP_ACCESS)[number];

export const ADMIN_SIGNUP_ACCESS_LABELS: Record<AdminSignupAccess, string> = {
  trial: `Essai ${ANALYSIS_TRIAL_DAYS} jours`,
  trial_extended: "Essai prolongé",
  analyse_paid: "Analyse (payant)",
  analyse_manual: "Analyse (attribué)",
  premium: "Accès complet",
  decouverte: "Découverte",
};

/** Durée maximale d'une prolongation d'essai, à compter de maintenant. */
export const TRIAL_EXTENSION_MAX_DAYS = 90;
/** Nombre maximal de comptes prolongés par appel. */
export const TRIAL_EXTENSION_MAX_ACCOUNTS = 25;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Ancienneté d'un compte : « aujourd’hui », « 3 jours », « 2 mois », « 1 an et 2 mois ». */
export function formatAccountSeniority(createdAt: string, now: Date = new Date()): string {
  const days = Math.floor((now.getTime() - Date.parse(createdAt)) / DAY_MS);
  if (!Number.isFinite(days) || days < 1) return "aujourd’hui";
  if (days < 60) return `${days} jour${days > 1 ? "s" : ""}`;
  const months = Math.floor(days / 30.44);
  if (months < 12) return `${months} mois`;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  const yearLabel = `${years} an${years > 1 ? "s" : ""}`;
  return rest ? `${yearLabel} et ${rest} mois` : yearLabel;
}

/** Fin de journée (23 h 59, heure locale du navigateur) dans `days` jours, pour un champ datetime-local. */
export function endOfDayInDays(days: number, now: Date = new Date()): Date {
  const date = new Date(now.getTime() + days * DAY_MS);
  date.setHours(23, 59, 0, 0);
  return date;
}
