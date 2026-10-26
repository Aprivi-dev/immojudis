import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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

/** Routes that are triggered by hand on purpose (see docs/operations/planification.md). */
const MANUAL_ROUTES = new Set(["cnb-lawyer-directory"]);

describe("scheduled jobs inventory", () => {
  it("planifie chaque route /api/cron/* dans vercel.json ou dans une migration pg_cron", () => {
    const vercel = vercelCronPaths();
    const migrations = migrationText();
    const unscheduled = cronRoutes().filter(
      (route) =>
        !MANUAL_ROUTES.has(route) &&
        !vercel.has(`/api/cron/${route}`) &&
        !migrations.includes(`api/cron/${route}`),
    );
    expect(unscheduled).toEqual([]);
  });

  it("documente chaque route dans docs/operations/planification.md", () => {
    const document = readFileSync(join(root, "docs/operations/planification.md"), "utf8");
    const undocumented = cronRoutes().filter((route) => !document.includes(`/api/cron/${route}`));
    expect(undocumented).toEqual([]);
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

  it("garde le rattrapage de l'envoi des alertes en phase avec vercel.json", () => {
    const vercel = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8")) as {
      crons: Array<{ path: string; schedule: string }>;
    };
    const schedules = vercel.crons
      .filter((cron) => cron.path === "/api/cron/alert-notifications")
      .map((cron) => cron.schedule);
    const route = readFileSync(join(root, "src/app/api/cron/alert-notifications/route.ts"), "utf8");
    const catchUp = /CATCH_UP_SCHEDULE = "([^"]+)"/.exec(route)?.[1];
    expect(catchUp).toBeDefined();
    // Le rattrapage est le second passage du jour, jamais le premier.
    expect(schedules).toContain(catchUp);
    expect(schedules.sort()[0]).not.toBe(catchUp);
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
