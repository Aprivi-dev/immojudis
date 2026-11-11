import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client.server", async () => {
  const { evaluationSupabase } = await import("./fake-supabase");
  return { supabaseAdmin: evaluationSupabase };
});

import {
  CASES_PER_FAMILY,
  EVALUATION_FAMILIES,
  EVALUATION_FIELDS,
  EVALUATION_ROOT,
  loadEvaluationCases,
  readEvaluationJson,
} from "./dataset";
import {
  runEngineStage,
  runRulesStage,
  type EngineStageEntry,
  type RulesStageEntry,
  type StageCandidate,
} from "./pipeline";
import { buildConfigurationReport, type ConfigurationReport, type KnownDefect } from "./report";

/**
 * Banc d'évaluation hors ligne de la publication automatique (proposition 8). Aucune base, aucun réseau,
 * aucun modèle. Étape 1 (règles TypeScript) → `stages/rules_stage.json` ; étape 2 (worker Python,
 * `services/data-pipeline/scripts/information_agent_evaluation.py`) → `stages/worker_stage.<config>.json` ;
 * étape 3 (moteur) → `report.json`. Mise à jour : voir `docs/runbooks/information-agent.md`.
 */

const cases = loadEvaluationCases();
const RULES_STAGE = "stages/rules_stage.json";
const RULES_STAGE_FORMAT = "information_agent_evaluation_rules_stage_v1";

function fixturePath(relative: string) {
  return join(process.cwd(), EVALUATION_ROOT, relative);
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 1)}\n`;
}

describe("jeu d'évaluation : schéma", () => {
  it("compte 200 cas, 8 familles de 25, identifiants uniques", () => {
    expect(cases).toHaveLength(EVALUATION_FAMILIES.length * CASES_PER_FAMILY);
    for (const { number } of EVALUATION_FAMILIES) {
      expect(
        cases.filter((item) => item.famille === number),
        `famille ${number}`,
      ).toHaveLength(CASES_PER_FAMILY);
    }
    expect(new Set(cases.map((item) => item.id)).size).toBe(cases.length);
  });

  it("n'a que des adresses en .example, expéditeur compris", () => {
    for (const { file } of EVALUATION_FAMILIES) {
      const text = readFileSync(fixturePath(`cases/${file}`), "utf8");
      const addresses = text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu) ?? [];
      expect(
        addresses.filter((address) => !address.endsWith(".example")),
        file,
      ).toEqual([]);
    }
  });

  it("tire chaque citation, mot pour mot, du texte de sa source", () => {
    for (const item of cases) {
      for (const field of EVALUATION_FIELDS) {
        const truth = item.verite[field];
        const reading = truth.publiable
          ? { citation: truth.citation, source: "corps", valeur: truth.valeur }
          : truth.lecture_modele;
        if (!reading) continue;
        const source =
          reading.source === "corps"
            ? item.message.corps
            : item.message.pieces_jointes.find((attachment) => attachment.nom === reading.source)
                ?.texte;
        expect(source, `${item.id} ${field} : source ${reading.source}`).toBeDefined();
        expect(source, `${item.id} ${field}`).toContain(reading.citation);
      }
    }
  });

  it("garde des valeurs publiables dans chaque famille et des cas non publiables par le seul contexte", () => {
    const publishable = cases
      .filter((item) => item.famille === 1)
      .flatMap((item) => EVALUATION_FIELDS.filter((field) => item.verite[field].publiable));
    expect(publishable.length).toBeGreaterThan(10);
    const contextOnly = cases.filter((item) => /contexte seul/iu.test(item.titre));
    expect(contextOnly.length).toBeGreaterThanOrEqual(8);
  });
});

describe("étape 1 : règles TypeScript", () => {
  it("écrit l'étape des règles à jour (stages/rules_stage.json)", async () => {
    const stage: Record<string, RulesStageEntry> = {};
    for (const item of cases) stage[item.id] = await runRulesStage(item);
    await expect(serialize({ format: RULES_STAGE_FORMAT, cas: stage })).toMatchFileSnapshot(
      fixturePath(RULES_STAGE),
    );
  });
});

type WorkerStage = {
  format: string;
  configuration: string;
  modele_reel: boolean;
  description: string;
  source: string | null;
  rules_stage_sha256: string;
  cas: Record<string, { candidates: StageCandidate[] } | { missing: true }>;
};

function workerStages(): WorkerStage[] {
  return readdirSync(fixturePath("stages"))
    .filter((name) => /^worker_stage\..+\.json$/u.test(name))
    .sort()
    .map((name) => readEvaluationJson(`stages/${name}`) as WorkerStage);
}

const knownDefects = (readEvaluationJson("known_defects.json") as { defauts: KnownDefect[] })
  .defauts;

describe("étape 3 : moteur de décision", () => {
  const reports = new Map<string, ConfigurationReport>();

  beforeAll(async () => {
    const rulesHash = createHash("sha256")
      .update(readFileSync(fixturePath(RULES_STAGE)))
      .digest("hex");
    for (const stage of workerStages()) {
      if (stage.rules_stage_sha256 !== rulesHash) {
        throw new Error(
          `${stage.configuration} : étape Python périmée, relancer scripts.information_agent_evaluation --write`,
        );
      }
      const decisions = new Map<string, EngineStageEntry>();
      const realState = new Map<string, EngineStageEntry>();
      const missing: string[] = [];
      for (const item of cases) {
        const entry = stage.cas[item.id];
        if (!entry || "missing" in entry) {
          missing.push(item.id);
          continue;
        }
        decisions.set(item.id, await runEngineStage(item, entry.candidates, "hypothese"));
        realState.set(item.id, await runEngineStage(item, entry.candidates, "etat_reel"));
      }
      reports.set(
        stage.configuration,
        buildConfigurationReport({
          configuration: stage.configuration,
          modeleReel: stage.modele_reel,
          description: stage.description,
          cases,
          decisions,
          realStateDecisions: realState,
          missing,
          knownDefects,
        }),
      );
    }
  }, 120_000);

  it("a les deux configurations simulées, jamais présentées comme une sortie réelle du modèle", () => {
    expect(reports.get("regles_seules")?.modele_reel).toBe(false);
    expect(reports.get("modele_ideal")?.modele_reel).toBe(false);
    for (const report of reports.values()) {
      const recorded = report.configuration.startsWith("enregistrement_");
      expect(report.modele_reel, report.configuration).toBe(recorded);
      if (!recorded) expect(report.description).toMatch(/^SIMULATION/u);
      if (recorded) {
        const name = report.configuration.replace(/^enregistrement_/u, "");
        expect(existsSync(fixturePath(`model_outputs/${name}.json`)), name).toBe(true);
      }
    }
  });

  it("règles seules : rien n'est publiable sans accord de l'IA (test de fermeture)", () => {
    const report = reports.get("regles_seules")!;
    expect(report.cas_joues).toBe(cases.length);
    expect(report.publications).toBe(0);
  });

  it("modèle idéal et sorties réelles : zéro publication fausse hors défauts connus", () => {
    for (const report of reports.values()) {
      const unexpected = report.publications_fausses.liste.filter((item) => !item.defaut_connu);
      expect(unexpected, report.configuration).toEqual([]);
    }
  });

  it("chaque défaut connu est encore observé (un défaut corrigé doit sortir de la liste)", () => {
    for (const defect of knownDefects) {
      const report = reports.get(defect.configuration);
      expect(report, defect.configuration).toBeDefined();
      expect(
        report!.publications_fausses.liste.some(
          (item) =>
            item.defaut_connu && item.case_id === defect.case_id && item.field === defect.field,
        ),
        `${defect.configuration} ${defect.case_id} ${defect.field}`,
      ).toBe(true);
    }
  });

  it("écrit le rapport à jour (report.json)", async () => {
    const payload = {
      _comment:
        "Rapport du banc d'évaluation. « regles_seules » et « modele_ideal » sont des SIMULATIONS, pas un résultat du modèle ; seules les configurations « enregistrement_* » (modele_reel : true) rejouent une sortie réelle.",
      configurations: [...reports.values()],
    };
    await expect(serialize(payload)).toMatchFileSnapshot(fixturePath("report.json"));
  });
});
