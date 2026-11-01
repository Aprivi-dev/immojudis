import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertPromotionGate,
  isReportFile,
  MIN_ACTIVATION_TEST_ROWS,
  promotionGateProblems,
  reportFileName,
} from "./valuation-promotion-gate.mjs";

const bundle = { segment: "apartment", version: "lgbm-v2" };

function gap(ciLow = -3, ciHigh = -1) {
  return { metric: "median_ape_pct", gap_pp: -2, ci_low_pp: ciLow, ci_high_pp: ciHigh };
}

/** Un rapport tel que l'écrit l'entraînement quand la porte laisse passer le modèle. */
function report(overrides = {}) {
  return {
    segment: "apartment",
    version: "lgbm-v2",
    split: { test_rows: 420 },
    candidate: { median_ape_pct: 9 },
    naive: { gate_median_ape_pct: 12 },
    active: { status: "evaluated", version: "lgbm-v1", median_ape_pct: 11 },
    coverage: { served_interval_pct: 78.5 },
    error_gap: { vs_naive: gap(), vs_active: gap() },
    promotion: { activation_requested: true, activate: true, reasons: [] },
    ...overrides,
  };
}

describe("porte d'activation des modèles de valorisation (publication)", () => {
  it("laisse passer un rapport dont la porte a validé le modèle", () => {
    expect(promotionGateProblems(bundle, report())).toEqual([]);
    expect(() => assertPromotionGate(bundle, report())).not.toThrow();
  });

  it("n'exige pas d'intervalle contre le modèle actif quand il n'y en a pas", () => {
    const first = report({
      active: { status: "none" },
      error_gap: { vs_naive: gap(), vs_active: null },
    });
    expect(promotionGateProblems(bundle, first)).toEqual([]);
  });

  it("refuse un lot sans rapport", () => {
    expect(promotionGateProblems(bundle, null)).toEqual([
      "rapport de la porte d'activation absent",
    ]);
    expect(() => assertPromotionGate(bundle, undefined)).toThrow(/refused by the activation gate/);
  });

  it("refuse un brouillon que la porte a écarté, en recopiant ses raisons", () => {
    const draft = report({
      promotion: { activation_requested: true, activate: false, reasons: ["coverage too low"] },
    });
    const problems = promotionGateProblems(bundle, draft);
    expect(problems[0]).toContain("n'a pas validé ce modèle");
    expect(problems[0]).toContain("coverage too low");
    const notRequested = report({ promotion: { activate: false, reasons: [] } });
    expect(promotionGateProblems(bundle, notRequested)).not.toEqual([]);
    expect(promotionGateProblems(bundle, report({ promotion: undefined }))).not.toEqual([]);
  });

  it("exige au moins 300 ventes de test", () => {
    expect(MIN_ACTIVATION_TEST_ROWS).toBe(300);
    expect(promotionGateProblems(bundle, report({ split: { test_rows: 300 } }))).toEqual([]);
    const few = promotionGateProblems(bundle, report({ split: { test_rows: 299 } }));
    expect(few).toHaveLength(1);
    expect(few[0]).toContain("299 ventes de test");
    expect(promotionGateProblems(bundle, report({ split: {} }))[0]).toContain("nombre inconnu");
  });

  it("refuse un intervalle bootstrap qui touche zéro, absent, ou contre le repère naïf", () => {
    const vsActive = promotionGateProblems(
      bundle,
      report({ error_gap: { vs_naive: gap(), vs_active: gap(-2, 0) } }),
    );
    expect(vsActive).toHaveLength(1);
    expect(vsActive[0]).toContain("le modèle actif lgbm-v1");
    expect(vsActive[0]).toContain("pas entièrement sous zéro");

    const vsNaive = promotionGateProblems(
      bundle,
      report({ error_gap: { vs_naive: gap(-1, 0.4), vs_active: gap() } }),
    );
    expect(vsNaive[0]).toContain("le repère naïf");

    const missing = promotionGateProblems(bundle, report({ error_gap: null }));
    expect(missing).toHaveLength(2);
    expect(missing.every((problem) => problem.includes("absent"))).toBe(true);
  });

  it("refuse un modèle actif non évaluable ou une couverture sous le plancher", () => {
    const unevaluable = report({ active: { status: "unevaluable", version: "lgbm-v1" } });
    expect(promotionGateProblems(bundle, unevaluable)[0]).toContain("n'a pas pu être évalué");
    const covered = promotionGateProblems(
      bundle,
      report({ coverage: { served_interval_pct: 69.9 } }),
    );
    expect(covered[0]).toContain("sous le plancher de 70 %");
    expect(promotionGateProblems(bundle, report({ coverage: {} }))[0]).toContain("non mesurée");
  });

  it("refuse un rapport qui décrit un autre lot", () => {
    const other = promotionGateProblems(bundle, report({ version: "lgbm-v1" }));
    expect(other).toHaveLength(1);
    expect(other[0]).toContain("ne décrit pas ce lot");
  });

  it("distingue les rapports des lots à publier", () => {
    expect(reportFileName("apartment-lgbm-v2.json")).toBe("apartment-lgbm-v2.report.json");
    expect(isReportFile("apartment-lgbm-v2.report.json")).toBe(true);
    expect(isReportFile("apartment-lgbm-v2.json")).toBe(false);
  });
});

describe("scripts/publish-valuation-models.mjs", () => {
  const script = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "publish-valuation-models.mjs"),
    "utf8",
  );

  it("passe chaque lot par la même porte que l'entraînement avant toute écriture", () => {
    expect(script).toContain("./lib/valuation-promotion-gate.mjs");
    const gate = script.indexOf("assertPromotionGate(bundle");
    const firstWrite = script.indexOf("sql.begin");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(firstWrite);
    // La validation seule (--validate-only) s'arrête après la porte, sans toucher à la base.
    expect(gate).toBeLessThan(script.indexOf("if (validateOnly)"));
  });

  it("ne traite pas un rapport comme un lot", () => {
    expect(script).toContain("!isReportFile(file)");
  });
});
