import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Verrou de l'envoi de l'agent d'information. Règle du 14/10/2026 : aucun e-mail ne part sans qu'un
 * administrateur l'ait déclenché, fiche par fiche, après l'aperçu. REMPLACÉE le 02/11/2026 par une règle à
 * exceptions NOMMÉES : le pilote automatique est le seul expéditeur automatisé, désactivé par défaut, limité à
 * l'avocat poursuivant de l'annonce, bloqué en mode réel par le contrôle de préparation. Les exceptions sont
 * exactement celles-ci, et rien d'autre :
 *   T2  `src/lib/information-agent-autopilot.ts` appelle `runAdminInformationAgentAction` (avec `trigger`) ;
 *   T3  `src/app/api/cron/information-agent-autopilot/route.ts` importe ce seul module d'envoi ;
 *   T5  la tâche pg_cron `immojudis-information-agent-autopilot`, qui n'appelle l'application que si le mode
 *       n'est pas « off ».
 * T1 (un seul appel au fournisseur, dans `approveAndSendMission`), T4 (aucune relance), T6 (ni Vercel Cron, ni
 * workflow, ni Python) et T7 (canari) sont inchangés.
 *
 * Ce test lit le dépôt : il échoue si un cron, un webhook, un workflow, une migration SQL, le
 * pipeline Python ou un module de traitement des réponses acquiert un chemin d'envoi autre que ces
 * exceptions. Le traitement automatique des réponses entrantes reste permis tant qu'il n'envoie rien.
 */
const ROOT = process.cwd();

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

function walk(relative: string, extensions: readonly string[]): string[] {
  const absolute = path.join(ROOT, relative);
  let entries: string[];
  try {
    entries = readdirSync(absolute);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const child = path.join(relative, entry);
    if (entry === "node_modules" || entry.startsWith(".venv") || entry === "__pycache__") {
      return [];
    }
    if (statSync(path.join(ROOT, child)).isDirectory()) return walk(child, extensions);
    return extensions.some((extension) => entry.endsWith(extension)) ? [child] : [];
  });
}

/** Découpage de `information-agent.ts` (lot 0) : l'envoi vit dans `send.ts`, le routeur dans la façade. */
const FACADE = path.join("src", "lib", "information-agent.ts");
const SEND_MODULE = path.join("src", "lib", "information-agent", "send.ts");
const SCHEMAS_MODULE = path.join("src", "lib", "information-agent", "schemas.ts");

const AUTOPILOT_ROUTE = path.join(
  "src",
  "app",
  "api",
  "cron",
  "information-agent-autopilot",
  "route.ts",
);
const AUTOPILOT_EXECUTOR = path.join("src", "lib", "information-agent-autopilot.ts");

const isTest = (file: string) => /\.(?:test|spec)\.[cm]?[jt]sx?$|\.scenarios\.test\./.test(file);
const sourceFiles = walk("src", [".ts", ".tsx"]).filter((file) => !isTest(file));

/** Corps d'une fonction de premier niveau (de sa déclaration à l'accolade fermante en colonne 0). */
function functionBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  if (start < 0) throw new Error(`Déclaration introuvable : ${declaration}`);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end + 3);
}

describe("agent d'information : aucun envoi automatique", () => {
  it("n'appelle le fournisseur d'e-mails qu'à un seul endroit : l'envoi validé par un admin", () => {
    const agentFiles = sourceFiles.filter((file) => /information-agent/.test(file));
    const callers = agentFiles.filter((file) => /\bsendTrackedEmail\s*\(/.test(read(file)));
    expect(callers).toEqual([SEND_MODULE]);

    const agent = read(SEND_MODULE);
    expect(agent.match(/\bsendTrackedEmail\s*\(/g)).toHaveLength(1);
    const sendPath = functionBody(agent, "export async function approveAndSendMission(");
    expect(sendPath).toMatch(/\bsendTrackedEmail\s*\(/);
    // L'envoi exige l'empreinte de l'aperçu, puis revérifie l'opposition juste avant l'appel.
    expect(sendPath.indexOf("assertInformationAgentPreviewFingerprint")).toBeGreaterThan(-1);
    expect(sendPath.indexOf("assertInformationAgentPreviewFingerprint")).toBeLessThan(
      sendPath.indexOf("sendTrackedEmail("),
    );
    expect(sendPath.lastIndexOf("assertInformationAgentContactAllowed")).toBeLessThan(
      sendPath.indexOf("sendTrackedEmail("),
    );
  });

  it("ne déclenche l'envoi que depuis l'action admin « approve_and_send »", () => {
    const agent = read(FACADE);
    const send = read(SEND_MODULE);
    // Déclaration (send.ts) + un seul appel, dans le routeur des actions administrateur (façade).
    expect(send.match(/\bapproveAndSendMission\s*\(/g)).toHaveLength(1);
    expect(agent.match(/\bapproveAndSendMission\s*\(/g)).toHaveLength(1);
    const otherCallers = sourceFiles.filter(
      (file) =>
        file !== FACADE && file !== SEND_MODULE && /\bapproveAndSendMission\s*\(/.test(read(file)),
    );
    expect(otherCallers).toEqual([]);
    const router = functionBody(agent, "export async function runAdminInformationAgentAction(");
    expect(router).toMatch(
      /input\.action === "approve_and_send"\)\s*\{\s*await approveAndSendMission\(/,
    );
    expect(router).toContain("requireInformationAgentAdmin(auth)");

    const routerUsers = sourceFiles.filter((file) =>
      /\brunAdminInformationAgentAction\b/.test(read(file)),
    );
    expect(routerUsers.sort()).toEqual(
      [
        path.join("src", "lib", "admin-information-agent.ts"),
        // Exception nommée T2 : le pilote automatique, avec `trigger: autopilot`.
        AUTOPILOT_EXECUTOR,
        FACADE,
      ].sort(),
    );
    const tokenUsers = sourceFiles.filter((file) =>
      /\brunAdminInformationAgentMissionActionForToken\b/.test(read(file)),
    );
    expect(tokenUsers.sort()).toEqual(
      [
        path.join("src", "app", "api", "admin", "information-agent", "missions", "route.ts"),
        path.join("src", "lib", "admin-information-agent.ts"),
      ].sort(),
    );
    // La route n'expose l'action qu'en PATCH administrateur, avec une confirmation explicite.
    const route = read("src/app/api/admin/information-agent/missions/route.ts");
    expect(route).toMatch(
      /async function handlePATCH[\s\S]*runAdminInformationAgentMissionActionForToken/,
    );
    const schemas = read(SCHEMAS_MODULE);
    expect(schemas).toMatch(/approvalConfirmed: z\.literal\(true\)/);
    expect(schemas).toMatch(/previewFingerprint: z\.string\(\)\.regex/);
  });

  it("garde les crons, webhooks et le traitement des réponses sans aucun chemin d'envoi", () => {
    const automated = sourceFiles.filter(
      (file) =>
        file !== AUTOPILOT_ROUTE && // exception nommée T3, vérifiée plus bas
        (file.startsWith(path.join("src", "app", "api", "cron")) ||
          file.startsWith(path.join("src", "app", "api", "webhooks")) ||
          /information-agent-inbound/.test(file) ||
          file === path.join("src", "lib", "information-agent-contribution.ts") ||
          file === path.join("src", "lib", "cron-jobs.ts")),
    );
    expect(automated.length).toBeGreaterThan(5);
    for (const file of automated) {
      const source = read(file);
      expect(source, file).not.toMatch(/from "@\/lib\/information-agent"/);
      expect(source, file).not.toMatch(
        /from "@\/lib\/information-agent\/(?:send|draft|preview|prepare|schemas|mission-store|config)"/,
      );
      expect(source, file).not.toMatch(/\b(?:sendResendEmail|sendTrackedEmail)\b/);
      expect(source, file).not.toMatch(/\bapproveAndSendMission\b|approve_and_send/);
      expect(source, file).not.toMatch(
        /\.emails\.send\s*\(|\.batch\.send\s*\(|api\.resend\.com\/emails/,
      );
    }
  });

  it("n'a aucune relance programmée : aucun message « followup » n'est jamais créé", () => {
    const writers = [...sourceFiles, ...walk("services/data-pipeline/src", [".py"])].filter(
      (file) => /message_kind["']?\s*[:=]\s*["']followup["']/.test(read(file)),
    );
    expect(writers).toEqual([]);
    // Les colonnes de relance héritées du premier schéma ne sont jamais alimentées par l'agent.
    for (const file of sourceFiles.filter((entry) => /information-agent/.test(entry))) {
      expect(read(file), file).not.toMatch(/followup_count\s*:|last_followup_at\s*:/);
    }
  });

  it("ne planifie côté base que la lecture des réponses entrantes", () => {
    const migrations = walk("supabase/migrations", [".sql"]);
    const agentSchedules = migrations.flatMap((file) =>
      [...read(file).matchAll(/cron\.schedule\(\s*'([^']+)'[\s\S]*?\);/g)]
        .filter((match) => /information[_-]agent/i.test(match[0]))
        .map((match) => ({ file, job: match[1], body: match[0] })),
    );
    // Exception nommée T5 : la tâche du pilote, en plus de la lecture des réponses.
    expect(agentSchedules.map((schedule) => schedule.job).sort()).toEqual([
      "immojudis-information-agent-autopilot",
      "immojudis-information-agent-inbound",
    ]);
    const bodyOf = (job: string) => agentSchedules.find((schedule) => schedule.job === job)?.body;
    expect(bodyOf("immojudis-information-agent-inbound")).toContain(
      "invoke_information_agent_inbound_endpoint()",
    );
    expect(bodyOf("immojudis-information-agent-autopilot")).toContain(
      "invoke_information_agent_autopilot_endpoint()",
    );
    for (const file of migrations) {
      const sql = read(file);
      expect(sql, file).not.toMatch(/api\.resend\.com/i);
      if (/invoke_information_agent_inbound_endpoint\(\)\s*\nreturns/.test(sql)) {
        const urls = [...sql.matchAll(/'\/api\/[a-z0-9/_-]+'/g)].map((match) => match[0]);
        expect(urls, file).toEqual(["'/api/cron/information-agent-inbound'"]);
      }
      if (/invoke_information_agent_autopilot_endpoint\(\)\s*\nreturns/.test(sql)) {
        // La fonction du pilote n'appelle l'application que si le mode n'est pas « off ».
        const fn = sql.slice(
          sql.search(/invoke_information_agent_autopilot_endpoint\(\)\s*\nreturns/),
        );
        expect(fn.indexOf("settings.mode <> 'off'"), file).toBeGreaterThan(-1);
        expect(fn.indexOf("settings.mode <> 'off'"), file).toBeLessThan(fn.indexOf("net.http_get"));
        expect(
          [...fn.slice(0, fn.indexOf("revoke all")).matchAll(/'\/api\/[a-z0-9/_-]+'/g)].map(
            (m) => m[0],
          ),
          file,
        ).toEqual(["'/api/cron/information-agent-autopilot'"]);
      }
    }
  });

  it("le pilote est le seul expéditeur automatisé", () => {
    // La route du pilote n'importe que le module du pilote (et le moniteur de tâches).
    const route = read(AUTOPILOT_ROUTE);
    const imports = [...route.matchAll(/from "([^"]+)"/g)].map((match) => match[1]).sort();
    expect(imports).toEqual(["@/lib/cron-jobs", "@/lib/information-agent-autopilot"]);
    expect(route).not.toMatch(
      /\b(?:sendResendEmail|sendTrackedEmail|approveAndSendMission|approve_and_send)\b/,
    );

    // Seul le pilote fabrique un déclencheur « autopilot » (les types et le brouillon ne font que le lire).
    const makers = sourceFiles.filter((file) => /kind:\s*"autopilot"/.test(read(file)));
    expect(makers.sort()).toEqual([AUTOPILOT_EXECUTOR, SCHEMAS_MODULE].sort());
    expect(read(SCHEMAS_MODULE)).toMatch(
      /type InformationAgentSendTrigger = \{\s*kind: "autopilot"/,
    );

    // Le module du pilote n'appelle jamais le fournisseur lui-même : un seul chemin d'envoi.
    const executor = read(AUTOPILOT_EXECUTOR);
    expect(executor).not.toMatch(
      /\b(?:sendResendEmail|sendTrackedEmail|approveAndSendMission)\s*\(/,
    );
    expect(executor).not.toMatch(/\.emails\.send\s*\(|api\.resend\.com\/emails\//);
    expect(executor.match(/runAdminInformationAgentAction\(/g)).toHaveLength(1);

    // Aucun autre fichier de l'application n'importe le pilote, hors sa route et ses tests.
    const importers = sourceFiles.filter((file) =>
      /from "@\/lib\/information-agent-autopilot"/.test(read(file)),
    );
    expect(importers).toEqual([AUTOPILOT_ROUTE]);
  });

  it("le filet SQL refuse un envoi du pilote hors du mode réel", () => {
    const migrations = walk("supabase/migrations", [".sql"]).sort();
    const guards = migrations.filter((file) =>
      /create or replace function app_private\.guard_information_agent_mission_contact\(\)/.test(
        read(file),
      ),
    );
    const latest = read(guards[guards.length - 1]);
    expect(latest).toMatch(/metadata ->> 'trigger' = 'autopilot'/);
    expect(latest).toMatch(/\) <> 'live'/);
  });

  it("n'a ni tâche Vercel, ni workflow, ni code Python qui envoie pour l'agent", () => {
    const crons =
      (JSON.parse(read("vercel.json")) as { crons?: Array<{ path: string }> }).crons ?? [];
    expect(crons.filter((cron) => /information-agent/.test(cron.path))).toEqual([]);

    for (const workflow of walk(".github/workflows", [".yml", ".yaml"])) {
      const content = read(workflow);
      expect(content, workflow).not.toMatch(/information-agent\/missions|approve_and_send/);
      expect(content, workflow).not.toMatch(/send-information-agent-provider-canary/);
      if (/information-agent/.test(workflow)) {
        expect(content, workflow).not.toMatch(/RESEND|SMTP/i);
      }
    }

    for (const file of walk("services/data-pipeline/src", [".py"])) {
      const content = read(file);
      expect(content, file).not.toMatch(
        /api\.resend\.com|import\s+smtplib|from\s+smtplib|resend\./,
      );
    }
  });

  it("limite le script canari du fournisseur à l'adresse de test Resend", () => {
    const canary = read("scripts/send-information-agent-provider-canary.mjs");
    expect(canary).toContain('RESEND_DELIVERY_TEST_ADDRESS = "delivered@resend.dev"');
    expect(canary).toMatch(/INFORMATION_AGENT_PROVIDER_CANARY !== "true"/);
    expect(canary).not.toMatch(/from ["']@supabase|@\/lib\//);
  });
});
