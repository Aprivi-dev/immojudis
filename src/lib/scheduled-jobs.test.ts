import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CRON_JOBS, CRON_JOB_NAMES, type CronJobTriggers } from "@/lib/scheduled-jobs";

const root = process.cwd();

function cronRoutes(): string[] {
  const directory = join(root, "src/app/api/cron");
  return readdirSync(directory).filter((entry) => statSync(join(directory, entry)).isDirectory());
}

function vercelCronPaths(): Set<string> {
  const config = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8")) as {
    crons?: Array<{ path: string }>;
  };
  return new Set((config.crons ?? []).map((cron) => cron.path));
}

function migrationText(): string {
  const directory = join(root, "supabase/migrations");
  return readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .map((file) => readFileSync(join(directory, file), "utf8"))
    .join("\n");
}

/**
 * Workflows GitHub autorisés à garder un `schedule` (règle de `planification.md` : des contrôles, plus une
 * exception qui tolère des heures de retard). Les horaires GitHub ne sont pas tenus : une tâche métier est
 * déclenchée par `workflow_dispatch` depuis l'application ou la base.
 */
const SCHEDULED_WORKFLOWS = [
  "check-pending-supabase-migrations.yml",
  "codeql.yml",
  "information-agent-evidence.yml",
  "pipeline-clock-offset.yml",
  "production-smoke.yml",
];

function scheduledWorkflows(): string[] {
  const directory = join(root, ".github/workflows");
  return readdirSync(directory)
    .filter((file) => /\.ya?ml$/.test(file))
    .filter((file) => /^\s*schedule:\s*$/m.test(readFileSync(join(directory, file), "utf8")))
    .sort();
}

describe("scheduled jobs inventory", () => {
  it("a une entrée de registre par dossier de src/app/api/cron, et aucune de plus", () => {
    expect([...CRON_JOB_NAMES].sort()).toEqual(cronRoutes().sort());
  });

  it("décrit dans le registre exactement les horaires de vercel.json", () => {
    const config = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8")) as {
      crons: Array<{ path: string; schedule: string }>;
    };
    const expected = CRON_JOB_NAMES.flatMap((name) => {
      const job: CronJobTriggers = CRON_JOBS[name];
      return [...(job.vercel ?? []), ...(job.catchUp ? [job.catchUp.schedule] : [])].map(
        (schedule) => `/api/cron/${name} ${schedule}`,
      );
    });
    const actual = config.crons.map((cron) => `${cron.path} ${cron.schedule}`);
    expect([...actual].sort()).toEqual([...expected].sort());
  });

  it("planifie dans une migration pg_cron chaque tâche que le registre dit appelée par pg_cron, et elles seules", () => {
    const migrations = migrationText();
    for (const name of CRON_JOB_NAMES) {
      const job: CronJobTriggers = CRON_JOBS[name];
      if (job.pgCron) expect(migrations, name).toContain(`api/cron/${name}`);
      if (job.manual) {
        expect(migrations, name).not.toContain(`api/cron/${name}`);
        expect(vercelCronPaths().has(`/api/cron/${name}`), name).toBe(false);
      }
      expect(Boolean(job.vercel || job.catchUp || job.pgCron || job.manual), name).toBe(true);
    }
  });

  it("documente chaque route dans docs/operations/planification.md", () => {
    const document = readFileSync(join(root, "docs/operations/planification.md"), "utf8");
    const undocumented = cronRoutes().filter((route) => !document.includes(`/api/cron/${route}`));
    expect(undocumented).toEqual([]);
  });

  it("ne laisse un horaire GitHub qu'aux workflows de contrôle listés, tous inventoriés dans planification.md", () => {
    expect(scheduledWorkflows()).toEqual(SCHEDULED_WORKFLOWS);
    const document = readFileSync(join(root, "docs/operations/planification.md"), "utf8");
    const undocumented = SCHEDULED_WORKFLOWS.filter((file) => !document.includes(`\`${file}\``));
    expect(undocumented).toEqual([]);
  });

  it("fait des filets quotidiens des tâches de pg_cron des rattrapages sans effet si pg_cron a réussi", () => {
    for (const name of ["listing-completeness", "sale-pepites", "sale-flood-risk"] as const) {
      const job: CronJobTriggers = CRON_JOBS[name];
      expect(job.pgCron, name).toBe(true);
      expect(job.vercel, name).toBeUndefined();
      expect(job.catchUp?.successWindowHours, name).toBe(2);
    }
  });

  it("place les trois tâches quotidiennes sous un second passage de rattrapage", () => {
    const vercel = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8")) as {
      crons: Array<{ path: string; schedule: string }>;
    };
    for (const route of [
      "smart-alerts",
      "alert-notifications",
      "sale-change-monitor",
      "sale-reminders",
    ]) {
      const schedules = vercel.crons.filter((cron) => cron.path === `/api/cron/${route}`);
      expect(schedules, route).toHaveLength(2);
    }
  });

  it("donne à l'email de fin d'essai un rattrapage le même jour, dans les 23 heures de reprise de la file", () => {
    const vercel = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8")) as {
      crons: Array<{ path: string; schedule: string }>;
    };
    const schedules = vercel.crons
      .filter((cron) => cron.path === "/api/cron/trial-end-email")
      .map((cron) => cron.schedule);
    expect(schedules).toEqual(["30 12 * * *", "30 14 * * *"]);
    expect(CRON_JOBS["trial-end-email"].catchUp.schedule).toBe("30 14 * * *");
  });

  it("lance les rappels d'audience après le suivi des changements dont ils lisent les événements", () => {
    const vercel = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8")) as {
      crons: Array<{ path: string; schedule: string }>;
    };
    const minutes = (route: string) =>
      vercel.crons
        .filter((cron) => cron.path === `/api/cron/${route}`)
        .map((cron) => {
          const [minute, hour] = cron.schedule.split(" ").map(Number);
          return hour * 60 + minute;
        })
        .sort((a, b) => a - b);
    const monitor = minutes("sale-change-monitor");
    const reminders = minutes("sale-reminders");
    expect(reminders).toHaveLength(2);
    // Chaque passage des rappels suit le passage du suivi correspondant.
    expect(reminders[0]).toBeGreaterThan(monitor[0]);
    expect(reminders[1]).toBeGreaterThan(monitor[1]);
  });

  it("place l'alerte de résultat après les rappels et le récapitulatif hebdomadaire après tous les autres emails (plan Hobby : ±59 min)", () => {
    const vercel = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8")) as {
      crons: Array<{ path: string; schedule: string }>;
    };
    const hours = (route: string) =>
      vercel.crons
        .filter((cron) => cron.path === `/api/cron/${route}`)
        .map((cron) => Number(cron.schedule.split(" ")[1]))
        .sort((a, b) => a - b);
    expect(hours("sale-results")).toHaveLength(1);
    expect(hours("weekly-digest")).toHaveLength(1);
    // Un cron tombe n'importe quand dans son heure : « après » veut dire une heure entière après le
    // dernier passage (rattrapage compris) des tâches dont il dépend.
    const [results] = hours("sale-results");
    const [weekly] = hours("weekly-digest");
    expect(results).toBeGreaterThan(Math.max(...hours("sale-reminders")));
    expect(results).toBeGreaterThan(Math.max(...hours("sale-change-monitor")));
    expect(weekly).toBeGreaterThan(Math.max(...hours("alert-notifications")));
    expect(weekly).toBeGreaterThan(Math.max(...hours("sale-reminders")));
    expect(weekly).toBeGreaterThan(results);
  });

  it("supervise les rappels d'audience comme les autres tâches quotidiennes", () => {
    const document = readFileSync(join(root, "docs/operations/planification.md"), "utf8");
    expect(document).toMatch(/`\/api\/cron\/sale-reminders`.*\| oui /);
    // Dans la migration d'origine, les apostrophes de la liste attendue de cron.stale sont doublées.
    expect(migrationText()).toContain("(''sale-reminders'', interval ''30 hours'')");
  });

  it("lance l'envoi des alertes dans l'heure qui suit leur évaluation (plan Hobby : ±59 min)", () => {
    const vercel = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8")) as {
      crons: Array<{ path: string; schedule: string }>;
    };
    const hours = (route: string) =>
      vercel.crons
        .filter((cron) => cron.path === `/api/cron/${route}`)
        .map((cron) => Number(cron.schedule.split(" ")[1]))
        .sort((a, b) => a - b);
    const evaluation = hours("smart-alerts");
    const sending = hours("alert-notifications");
    expect(sending).toHaveLength(2);
    // Sur le plan Hobby un cron tombe n'importe quand dans son heure : deux tâches de la même heure
    // n'ont aucun ordre garanti. L'envoi passe donc une heure entière après l'évaluation.
    expect(sending[0]).toBeGreaterThan(evaluation[0]);
    expect(sending[1]).toBeGreaterThan(evaluation[1]);
    // Et après l'heure à laquelle les notifications créées par l'évaluation sont prévues (07:00 UTC).
    expect(sending[0]).toBeGreaterThanOrEqual(7);
  });

  it("fait toujours du rattrapage le second passage du jour, jamais le premier", () => {
    for (const name of CRON_JOB_NAMES) {
      const job: CronJobTriggers = CRON_JOBS[name];
      if (!job.catchUp || !job.vercel) continue;
      const minutes = (schedule: string) => {
        const [minute, hour] = schedule.split(" ").map(Number);
        return hour * 60 + minute;
      };
      for (const schedule of job.vercel) {
        expect(minutes(job.catchUp.schedule), name).toBeGreaterThan(minutes(schedule));
      }
    }
  });

  it("déclare maxDuration sur les routes de longue durée (un littéral : Next.js le lit à la compilation)", () => {
    for (const route of [
      "sale-change-monitor",
      "alert-notifications",
      "data-retention",
      "smart-alerts",
    ]) {
      const source = readFileSync(join(root, `src/app/api/cron/${route}/route.ts`), "utf8");
      expect(source, route).toMatch(/^export const maxDuration = \d+;$/m);
    }
  });

  it("attend les tâches quotidiennes toutes les 27 heures (un passage de rattrapage compris)", () => {
    // La dernière migration qui redéfinit la liste attendue de cron.stale.
    const definition = readFileSync(
      join(root, "supabase/migrations/20261029170000_operational_health_alerts.sql"),
      "utf8",
    );
    for (const job of [
      "smart-alerts",
      "alert-notifications",
      "sale-change-monitor",
      "sale-reminders",
    ]) {
      expect(definition, job).toContain(`('${job}', interval '27 hours')`);
    }
    expect(definition).not.toContain("interval '30 hours'");
  });
  it("contrôle le registre des pièces chaque jour (Vercel Cron), sous cron.stale à 27 heures", () => {
    const vercel = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8")) as {
      crons: Array<{ path: string; schedule: string }>;
    };
    expect(vercel.crons.filter((cron) => cron.path === "/api/cron/fact-registry-check")).toEqual([
      { path: "/api/cron/fact-registry-check", schedule: "28 5 * * *" },
    ]);

    // Dans la migration, les apostrophes de la liste attendue de cron.stale sont doublées.
    const supervision = readFileSync(
      join(root, "supabase/migrations/20261117100600_cron_stale_fact_registry_check.sql"),
      "utf8",
    );
    expect(supervision).toContain("(''fact-registry-check'', interval ''27 hours'')");

    const document = readFileSync(join(root, "docs/operations/planification.md"), "utf8");
    expect(document).toMatch(/`\/api\/cron\/fact-registry-check`.*\| oui /);
    const route = readFileSync(join(root, "src/app/api/cron/fact-registry-check/route.ts"), "utf8");
    expect(route).toMatch(/^export const maxDuration = \d+;$/m);
    // Le nom supervisé est celui que la migration attend.
    expect(route).toContain('"fact-registry-check"');
  });

  it("calcule les pépites toutes les heures à :35 (pg_cron), avec un filet quotidien et une alerte de fraîcheur", () => {
    const scheduler = readFileSync(
      join(root, "supabase/migrations/20261104100100_sale_pepites_scheduler.sql"),
      "utf8",
    );
    expect(scheduler).toContain("'immojudis-sale-pepites'");
    expect(scheduler).toContain("'35 * * * *'");
    expect(scheduler).toContain("/api/cron/sale-pepites");
    // Dans la migration, les apostrophes de la liste attendue de cron.stale sont doublées.
    expect(scheduler).toContain("(''sale-pepites'', interval ''3 hours'')");

    const vercel = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8")) as {
      crons: Array<{ path: string; schedule: string }>;
    };
    expect(vercel.crons.filter((cron) => cron.path === "/api/cron/sale-pepites")).toEqual([
      { path: "/api/cron/sale-pepites", schedule: "42 5 * * *" },
    ]);

    const document = readFileSync(join(root, "docs/operations/planification.md"), "utf8");
    expect(document).toMatch(/`\/api\/cron\/sale-pepites`.*\| oui /);
    const route = readFileSync(join(root, "src/app/api/cron/sale-pepites/route.ts"), "utf8");
    expect(route).toMatch(/^export const maxDuration = \d+;$/m);
  });

  it("observe le risque d'inondation toutes les heures à :25 (pg_cron), avec un filet quotidien et une alerte de fraîcheur", () => {
    const scheduler = readFileSync(
      join(root, "supabase/migrations/20261106100300_sale_flood_risk_scheduler.sql"),
      "utf8",
    );
    expect(scheduler).toContain("'immojudis-sale-flood-risk'");
    expect(scheduler).toContain("'25 * * * *'");
    expect(scheduler).toContain("/api/cron/sale-flood-risk");
    // Dans la migration, les apostrophes de la liste attendue de cron.stale sont doublées.
    expect(scheduler).toContain("(''sale-flood-risk'', interval ''3 hours'')");
    // L'observation précède le calcul des pépites (:35) qui lit le verdict.
    const pepites = readFileSync(
      join(root, "supabase/migrations/20261104100100_sale_pepites_scheduler.sql"),
      "utf8",
    );
    expect(pepites).toContain("'35 * * * *'");

    const vercel = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8")) as {
      crons: Array<{ path: string; schedule: string }>;
    };
    expect(vercel.crons.filter((cron) => cron.path === "/api/cron/sale-flood-risk")).toEqual([
      { path: "/api/cron/sale-flood-risk", schedule: "35 5 * * *" },
    ]);

    const document = readFileSync(join(root, "docs/operations/planification.md"), "utf8");
    expect(document).toMatch(/`\/api\/cron\/sale-flood-risk`.*\| oui /);
    expect(document).toContain("PEPITE_RULE_V2_ENABLED");
    const route = readFileSync(join(root, "src/app/api/cron/sale-flood-risk/route.ts"), "utf8");
    expect(route).toMatch(/^export const maxDuration = \d+;$/m);
  });
});
