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
  CURRENT_REQUEST_FILE,
  EVALUATION_CASE_COUNT,
  EVALUATION_FAMILIES,
  EVALUATION_FIELDS,
  EVALUATION_ROOT,
  loadEvaluationCases,
  readEvaluationJson,
  renderCurrentRequest,
} from "./dataset";
import {
  runEngineStage,
  runRulesStage,
  type EngineStageEntry,
  type RulesStageEntry,
  type StageCandidate,
} from "./pipeline";
import {
  buildConfigurationReport,
  type ConfigurationReport,
  type KnownDefect,
  type TrialCompleteness,
} from "./report";

/**
 * Banc d'évaluation hors ligne de la publication automatique (proposition 8). Aucune base, aucun réseau,
 * aucun modèle. Étape 1 (réception et règles TypeScript) → `stages/rules_stage.json` ; étape 2 (worker
 * Python, `services/data-pipeline/scripts/information_agent_evaluation.py`) →
 * `stages/worker_stage.<config>.json` ; étape 3 (moteur) → `report.json`. Mise à jour : voir
 * `docs/runbooks/information-agent.md`.
 */

const cases = loadEvaluationCases();
const RULES_STAGE = "stages/rules_stage.json";
const RULES_STAGE_FORMAT = "information_agent_evaluation_rules_stage_v2";
const SIMULATED = ["regles_seules", "modele_ideal", "suiveur"];
/** Configuration simulée qui fait foi pour la sécurité (la plus pessimiste). */
const AUTHORITATIVE = "suiveur";

function fixturePath(relative: string) {
  return join(process.cwd(), EVALUATION_ROOT, relative);
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 1)}\n`;
}

describe("jeu d'évaluation : schéma", () => {
  it("compte 215 cas : 8 familles de 25 et 15 compléments, identifiants uniques", () => {
    expect(cases).toHaveLength(EVALUATION_CASE_COUNT);
    for (const { number } of EVALUATION_FAMILIES) {
      expect(
        cases.filter((item) => item.famille === number),
        `famille ${number}`,
      ).toHaveLength(CASES_PER_FAMILY[number]!);
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
      const neighbours = new Map([
        ...item.contexte.messages_anterieurs.map(
          (message, index) => [`anterieur-${index + 1}`, message.corps] as const,
        ),
        ...item.contexte.messages_posterieurs.map(
          (message, index) => [`posterieur-${index + 1}`, message.corps] as const,
        ),
      ]);
      for (const field of EVALUATION_FIELDS) {
        const truth = item.verite[field];
        const reading = truth.publiable
          ? { citation: truth.citation, source: truth.source ?? "corps" }
          : truth.lecture_modele;
        if (!reading) continue;
        const source =
          reading.source === "corps"
            ? item.message.corps
            : (neighbours.get(reading.source) ??
              item.message.pieces_jointes.find((attachment) => attachment.nom === reading.source)
                ?.texte);
        expect(source, `${item.id} ${field} : source ${reading.source}`).toBeDefined();
        expect(source, `${item.id} ${field}`).toContain(reading.citation);
      }
    }
  });

  it("applique les règles prudentes : toute pièce jointe rend chaque champ non publiable", () => {
    for (const item of cases.filter((candidate) => candidate.message.pieces_jointes.length)) {
      for (const field of EVALUATION_FIELDS) {
        expect(item.verite[field].publiable, `${item.id} ${field}`).toBe(false);
      }
    }
    const owner = cases.filter((item) => item.decision_proprietaire);
    expect(
      owner.filter((item) => item.decision_proprietaire === "collaborateur_en_signature").length,
    ).toBeGreaterThanOrEqual(2);
    for (const item of owner.filter(
      (candidate) => candidate.decision_proprietaire === "collaborateur_en_signature",
    )) {
      expect(
        EVALUATION_FIELDS.some((field) => item.verite[field].publiable),
        item.id,
      ).toBe(false);
    }
  });

  it("est varié : demande citée en entier, valeurs de terrain, contexte non publiable par lui-même", () => {
    const request = renderCurrentRequest();
    // Notre demande telle que le gabarit la rend (salutation adaptée à l'avocat, chevrons acceptés).
    const tail = request.split("\n").slice(1).filter(Boolean);
    const quoted = cases.filter((item) => tail.every((line) => item.message.corps.includes(line)));
    expect(quoted.length).toBeGreaterThanOrEqual(60);
    expect(
      cases.filter((item) => item.verite.land_surface_m2.publiable).length,
    ).toBeGreaterThanOrEqual(20);
    expect(
      cases.filter((item) => /contexte seul/iu.test(item.titre)).length,
    ).toBeGreaterThanOrEqual(8);
    expect(
      cases.filter((item) => item.contexte.authentification.dmarc !== "pass").length,
    ).toBeGreaterThanOrEqual(2);
    expect(new Set(cases.map((item) => item.message.expediteur)).size).toBeGreaterThanOrEqual(20);
    expect(new Set(cases.map((item) => item.contexte.delai_jours)).size).toBeGreaterThanOrEqual(15);
  });

  it("fige le texte actuel de notre demande, que les réponses du jeu citent mot pour mot", async () => {
    await expect(`${renderCurrentRequest()}\n`).toMatchFileSnapshot(
      fixturePath(CURRENT_REQUEST_FILE),
    );
  });
});

describe("étape 1 : réception et règles TypeScript", () => {
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
  essai: TrialCompleteness | null;
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
    const rules = (readEvaluationJson(RULES_STAGE) as { cas: Record<string, RulesStageEntry> }).cas;
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
        const rulesEntry = rules[item.id]!;
        decisions.set(
          item.id,
          await runEngineStage(item, rulesEntry, entry.candidates, "hypothese"),
        );
        realState.set(
          item.id,
          await runEngineStage(item, rulesEntry, entry.candidates, "etat_reel"),
        );
      }
      reports.set(
        stage.configuration,
        buildConfigurationReport({
          configuration: stage.configuration,
          modeleReel: stage.modele_reel,
          description: stage.description,
          faitFoi: stage.modele_reel || stage.configuration === AUTHORITATIVE,
          essai: stage.essai,
          cases,
          decisions,
          realStateDecisions: realState,
          missing,
          knownDefects,
        }),
      );
    }
  }, 300_000);

  it("a les trois configurations simulées, jamais présentées comme une sortie réelle du modèle", () => {
    for (const name of SIMULATED) {
      const report = reports.get(name);
      expect(report, name).toBeDefined();
      expect(report!.modele_reel).toBe(false);
      expect(report!.description).toMatch(/^SIMULATION/u);
    }
    for (const report of reports.values()) {
      const recorded = report.configuration.startsWith("enregistrement_");
      expect(report.modele_reel, report.configuration).toBe(recorded);
      if (recorded) {
        const name = report.configuration.replace(/^enregistrement_/u, "");
        expect(existsSync(fixturePath(`model_outputs/${name}.json`)), name).toBe(true);
      }
    }
    expect(reports.get(AUTHORITATIVE)!.fait_foi).toBe(true);
  });

  it("joue tous les cas des configurations simulées", () => {
    for (const name of SIMULATED) {
      expect(reports.get(name)!.cas_non_joues, name).toEqual([]);
      expect(reports.get(name)!.resultat, name).toBe("complet");
    }
  });

  it("règles seules : rien n'est publiable sans accord de l'IA, dans les deux états (fermeture)", () => {
    const report = reports.get("regles_seules")!;
    expect(report.etat_attendu!.publications).toBe(0);
    expect(report.etat_reel!.publications).toBe(0);
  });

  it("zéro publication fausse hors défauts connus, dans les deux états, pour toute configuration", () => {
    for (const report of reports.values()) {
      for (const state of [report.etat_attendu, report.etat_reel]) {
        if (!state) continue;
        const unexpected = state.publications_fausses.liste.filter((item) => !item.defaut_connu);
        expect(unexpected, report.configuration).toEqual([]);
      }
    }
  });

  it("sortie réelle : essai complet exigé, et aucun défaut connu ne l'excuse", () => {
    expect(
      knownDefects.filter((defect) => defect.configuration.startsWith("enregistrement_")),
    ).toEqual([]);
    for (const report of reports.values()) {
      if (!report.modele_reel) continue;
      expect(report.resultat, report.configuration).toBe("complet");
      expect(report.cas_non_joues).toEqual([]);
      expect(report.essai?.pieces_en_erreur).toEqual([]);
      expect(report.essai?.pieces_en_cours).toEqual([]);
      expect(report.essai?.pieces_non_appelees_autres).toEqual([]);
    }
  });

  it("chaque défaut connu est encore observé (un défaut corrigé doit sortir de la liste)", () => {
    for (const defect of knownDefects) {
      const report = reports.get(defect.configuration);
      expect(report, defect.configuration).toBeDefined();
      const state = defect.etat === "etat_attendu" ? report!.etat_attendu : report!.etat_reel;
      expect(
        state!.publications_fausses.liste.some(
          (item) =>
            item.defaut_connu &&
            item.case_id === defect.case_id &&
            item.field === defect.field &&
            item.published_value === defect.published_value,
        ),
        `${defect.configuration} ${defect.etat} ${defect.case_id} ${defect.field}`,
      ).toBe(true);
    }
  });

  it("écrit le rapport à jour (report.json)", async () => {
    const payload = {
      _comment:
        "Rapport du banc d'évaluation. « regles_seules », « modele_ideal » et « suiveur » sont des SIMULATIONS, pas un résultat du modèle ; « suiveur » (le modèle confirme tout ce que lisent les règles) fait foi pour la sécurité tant qu'aucun essai réel complet n'est enregistré. « etat_attendu » : état du dossier que le moteur exige ; « etat_reel » : état que la chaîne écrit vraiment.",
      configurations: [...reports.values()],
    };
    await expect(serialize(payload)).toMatchFileSnapshot(fixturePath("report.json"));
  });
});
