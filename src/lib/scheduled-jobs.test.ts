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

  it("supervise les rappels d'audience comme les autres tâches quotidiennes", () => {
    const document = readFileSync(join(root, "docs/operations/planification.md"), "utf8");
    expect(document).toMatch(/`\/api\/cron\/sale-reminders`.*\| oui /);
    // Dans la migration, les apostrophes de la liste attendue de cron.stale sont doublées.
    expect(migrationText()).toContain("(''sale-reminders'', interval ''30 hours'')");
  });
});
