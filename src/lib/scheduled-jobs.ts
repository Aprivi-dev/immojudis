/**
 * Registre des routes `/api/cron/*`, seul endroit qui dit comment chacune est déclenchée :
 *
 * - `vercel` : les horaires de `vercel.json` (Vercel Cron, plan Hobby : le passage tombe n'importe quand
 *   dans l'heure demandée) ;
 * - `catchUp` : le passage Vercel de rattrapage, sans effet si la tâche a réussi depuis
 *   `successWindowHours` heures (20 par défaut). `runMonitoredCron` le reconnaît à l'en-tête
 *   `x-vercel-cron-schedule` ;
 * - `pgCron` : appelée par Supabase `pg_cron` (horaires dans les migrations) ;
 * - `manual` : lancée à la main.
 *
 * `scheduled-jobs.test.ts` vérifie que `vercel.json`, les migrations, les dossiers de `src/app/api/cron` et
 * `docs/operations/planification.md` disent la même chose que ce registre.
 */
export type CronJobTriggers = {
  vercel?: readonly string[];
  catchUp?: { schedule: string; successWindowHours?: number };
  pgCron?: true;
  manual?: true;
};

export const CRON_JOBS = {
  "alert-notifications": {
    // Une heure après `smart-alerts` (06:15, rattrapage 08:15) : deux tâches de la même heure n'ont
    // aucun ordre garanti, et les notifications qu'elle crée sont prévues à 07:00 UTC.
    vercel: ["30 7 * * *"],
    catchUp: { schedule: "30 9 * * *" },
  },
  "billing-reconciliation": { vercel: ["20 5 * * *"] },
  "cnb-lawyer-directory": { manual: true },
  "data-retention": { vercel: ["15 4 * * 0"] },
  "fact-registry-check": { vercel: ["28 5 * * *"] },
  "information-agent-autopilot": { pgCron: true },
  "information-agent-inbound": { pgCron: true },
  // Passage horaire par pg_cron ; le filet quotidien ne sert que si ce chemin est en panne.
  "listing-completeness": {
    pgCron: true,
    catchUp: { schedule: "50 5 * * *", successWindowHours: 2 },
  },
  "operational-health": { pgCron: true },
  "precompute-valuations": { pgCron: true },
  "replies-review-digest": { vercel: ["5 7 * * *"] },
  "sale-change-monitor": { vercel: ["45 6 * * *"], catchUp: { schedule: "45 8 * * *" } },
  "sale-flood-risk": { pgCron: true, catchUp: { schedule: "35 5 * * *", successWindowHours: 2 } },
  "sale-pepites": { pgCron: true, catchUp: { schedule: "42 5 * * *", successWindowHours: 2 } },
  // Après le suivi des changements, dont les rappels lisent les événements.
  "sale-reminders": { vercel: ["15 7 * * *"], catchUp: { schedule: "15 9 * * *" } },
  "sale-results": { vercel: ["15 10 * * *"] },
  "sale-retention": { pgCron: true },
  "smart-alerts": { vercel: ["15 6 * * *"], catchUp: { schedule: "15 8 * * *" } },
  // Rattrapage le même jour, dans les 23 heures de reprise de la file.
  "trial-end-email": { vercel: ["30 12 * * *"], catchUp: { schedule: "30 14 * * *" } },
  "weekly-digest": { vercel: ["30 11 * * *"] },
} as const satisfies Record<string, CronJobTriggers>;

export type CronJobName = keyof typeof CRON_JOBS;

export const CRON_JOB_NAMES = Object.keys(CRON_JOBS) as CronJobName[];
