import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Verrou de la règle du propriétaire : AUCUN e-mail de l'agent d'information (premier message ou
 * relance) ne part sans qu'un administrateur l'ait déclenché, fiche par fiche, après l'aperçu.
 *
 * Ce test lit le dépôt : il échoue si un cron, un webhook, un workflow, une migration SQL, le
 * pipeline Python ou un module de traitement des réponses acquiert un chemin d'envoi. Le
 * traitement automatique des réponses entrantes reste permis tant qu'il n'envoie rien.
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
    const callers = agentFiles.filter((file) => /\bsendResendEmail\s*\(/.test(read(file)));
    expect(callers).toEqual([path.join("src", "lib", "information-agent.ts")]);

    const agent = read("src/lib/information-agent.ts");
    expect(agent.match(/\bsendResendEmail\s*\(/g)).toHaveLength(1);
    const sendPath = functionBody(agent, "async function approveAndSendMission(");
    expect(sendPath).toMatch(/\bsendResendEmail\s*\(/);
    // L'envoi exige l'empreinte de l'aperçu, puis revérifie l'opposition juste avant l'appel.
    expect(sendPath.indexOf("assertInformationAgentPreviewFingerprint")).toBeGreaterThan(-1);
    expect(sendPath.indexOf("assertInformationAgentPreviewFingerprint")).toBeLessThan(
      sendPath.indexOf("sendResendEmail("),
    );
    expect(sendPath.lastIndexOf("assertInformationAgentContactAllowed")).toBeLessThan(
      sendPath.indexOf("sendResendEmail("),
    );
  });

  it("ne déclenche l'envoi que depuis l'action admin « approve_and_send »", () => {
    const agent = read("src/lib/information-agent.ts");
    const calls = agent.match(/\bapproveAndSendMission\s*\(/g) ?? [];
    // Déclaration + un seul appel, dans le routeur des actions administrateur.
    expect(calls).toHaveLength(2);
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
        path.join("src", "lib", "information-agent.ts"),
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
    expect(agent).toMatch(/approvalConfirmed: z\.literal\(true\)/);
    expect(agent).toMatch(/previewFingerprint: z\.string\(\)\.regex/);
  });

  it("garde les crons, webhooks et le traitement des réponses sans aucun chemin d'envoi", () => {
    const automated = sourceFiles.filter(
      (file) =>
        file.startsWith(path.join("src", "app", "api", "cron")) ||
        file.startsWith(path.join("src", "app", "api", "webhooks")) ||
        /information-agent-inbound/.test(file) ||
        file === path.join("src", "lib", "information-agent-contribution.ts") ||
        file === path.join("src", "lib", "cron-jobs.ts"),
    );
    expect(automated.length).toBeGreaterThan(5);
    for (const file of automated) {
      const source = read(file);
      expect(source, file).not.toMatch(/from "@\/lib\/information-agent"/);
      expect(source, file).not.toMatch(/\bsendResendEmail\b/);
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
    expect(agentSchedules.map((schedule) => schedule.job)).toEqual([
      "immojudis-information-agent-inbound",
    ]);
    expect(agentSchedules[0].body).toContain("invoke_information_agent_inbound_endpoint()");
    for (const file of migrations) {
      const sql = read(file);
      expect(sql, file).not.toMatch(/api\.resend\.com/i);
      if (/invoke_information_agent_inbound_endpoint\(\)\s*\nreturns/.test(sql)) {
        const urls = [...sql.matchAll(/'\/api\/[a-z0-9/_-]+'/g)].map((match) => match[0]);
        expect(urls, file).toEqual(["'/api/cron/information-agent-inbound'"]);
      }
    }
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
